/**
 * dsh-autoresume：web 重启后对**任一被重启打断的会话**做一次「自动继续」。
 * scanMode=true（默认）时扫描 ~/.dsh/sessions 下所有会话（仅处理最后活动在
 * scanWindowMs 窗口内的），持久化事件流停在中间态（open turn/无结果 tool call/
 * interrupted）或**网络故障停止**（最后 turn/end 为可重试错误码/网络特征消息，
 * 含账户余额类 QUOTA/402/Insufficient balance——充值或换 provider 后可恢复）
 * 才注入「继续」；completed/settled 一律不动。保留单目标兼容：
 * 配置 targetSessionId 时只服务该会话（旧行为）。
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';

export const name = 'dsh-autoresume';
export const inject = ['agents', 'sessions', 'sessionPersistence'];

const DEFAULT_TARGET_SESSION_ID = 'session-00000000-0000-0000-0000-000000000000';
const DEFAULT_PROMPT_TEXT = '继续（自动）';
const NOTICE_SUMMARY = 'autoresume：检测到上次重启打断，自动继续';

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function toolResultCallId(data) {
  const source = data?.message?.source;
  if (source && source.kind === 'tool') return source.callId;
  const blocks = data?.message?.content;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block && typeof block === 'object' && block.callId !== undefined) return block.callId;
    }
  }
  return undefined;
}

function isOurContinueMessage(event, continueText = DEFAULT_PROMPT_TEXT) {
  const data = event?.data;
  const source = data?.source;
  if (!source || source.kind !== 'plugin' || source.plugin !== 'dsh-autoresume') return false;
  const blocks = data?.content;
  if (!Array.isArray(blocks)) return false;
  return blocks.some(block => block && block.type === 'text' && block.text === continueText);
}

/**
 * DSH dsh-llm 官方可重试错误码（= 瞬时/网络类故障，重试可恢复），见
 * @deepseek-ai/dsh-llm retry-policy DEFAULT_RETRYABLE_CODES。
 */
const RETRYABLE_LLM_CODES = new Set(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'rate_limit_exceeded', 'too_many_requests', 'QUOTA', 'insufficient_balance', 'payment_required']);

/** DSH API 直出瞬时/上游错误 type（实证 service_unavailable；server_error 为 5xx 标准语义）。 */
const RETRYABLE_LLM_TYPES = new Set(['service_unavailable', 'server_error']);

/** 兜底消息特征：官方码集合外但消息明确为瞬时网络/上游故障（如 PI_AI_ERROR: Upstream error…）。 */
const NETWORK_FAILURE_PATTERN = /(upstream error|internal server error|service temporarily unavailable|currently overloaded|please try again later|all endpoints are currently overloaded|\b429\b|\b402\b|\b5\d\d\b|gateway time-?out|timed\s?out|fetch failed|econnreset|econnrefused|etimedout|socket hang up|network error|connection\s+(?:refused|reset|closed)|insufficient balance|payment required|payment required to access|quota exceeded|quota exhausted)/i;

/** 解开 DSH/OpenAI 风格错误信封：{ error: { code?, type?, message? } } → 递归剥到最内层对象。
 * 2026-08-31：由单层改为递归（外部用户环境 504 Gateway Time-out 曾因多层嵌套
 * 信封判 settled 不注入）；同时优先取 failure 负载（部分 adapter 把真实错误放该字段）。 */
function unwrapError(error) {
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== 'object') break;
    if (current.error && typeof current.error === 'object') {
      current = current.error;
      continue;
    }
    if (current.failure && typeof current.failure === 'object') {
      current = current.failure;
      continue;
    }
    break;
  }
  return current;
}

/** 判定 turn/end 的错误对象（{code?, type?, message?}）是否属于网络/瞬时故障。 */
function isNetworkFailure(error) {
  const inner = unwrapError(error);
  if (!inner || typeof inner !== 'object') return false;
  const code = typeof inner.code === 'string' ? inner.code : '';
  if (RETRYABLE_LLM_CODES.has(code)) return true;
  const type = typeof inner.type === 'string' ? inner.type : '';
  if (RETRYABLE_LLM_TYPES.has(type)) return true;
  const message = typeof inner.message === 'string' ? inner.message : '';
  return NETWORK_FAILURE_PATTERN.test(message);
}

function describeFailure(error) {
  const inner = unwrapError(error);
  if (!inner || typeof inner !== 'object') return 'unknown';
  const code = typeof inner.code === 'string' ? inner.code : '';
  const message = typeof inner.message === 'string' ? inner.message : '';
  return [code, message].filter(Boolean).join(': ').slice(0, 160) || 'unknown';
}

/**
 * 对持久化事件流做一次性状态判定：
 * - completed：最后是 assistant 完成回复，或最后一个 turn/end 已完成且其后没有新用户消息；
 * - interrupted：turn/step 打开未闭合、存在无结果的 tool/call、或最后一个 turn/end 原因为 interrupted；
 * - network-stopped：最后一个 turn/end 为 error 且属于网络/瞬时故障（可重试），同样注入「继续」；
 * - settled：有闭合边界但既非 completed 也非 interrupted/network-stopped（如 cancelled/配置类 error），不动作避免注入循环；
 * - empty：尚无事件。
 */
export function analyzeSessionEvents(events, continueText = DEFAULT_PROMPT_TEXT) {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return { state: 'empty', reason: 'no events' };

  let lastTurnStart = -1;
  let lastTurnEnd = -1;
  let lastStepStart = -1;
  let lastStepEnd = -1;
  let lastAssistant = -1;
  let lastUser = -1;
  let lastUserIsOurs = false;
  let lastTurnEndReason = null;
  let lastTurnEndError = null;
  // 自动继续死循环守卫：跟踪我们上次注入「继续」之后是否产生了内容/工具调用。
  let lastOursSeq = -1;
  let assistantAfterOurs = false;
  let toolAfterOurs = false;
  const pendingCalls = new Set();

  for (const event of list) {
    switch (event?.type) {
      case 'turn/start':
        lastTurnStart = event.seq;
        break;
      case 'turn/end':
        lastTurnEnd = event.seq;
        lastTurnEndReason = event.data?.reason?.kind ?? null;
        lastTurnEndError = event.data?.reason?.error ?? event.data?.reason?.failure ?? null;
        break;
      case 'step/start':
        lastStepStart = event.seq;
        break;
      case 'step/end':
        lastStepEnd = event.seq;
        break;
      case 'assistant/message':
        lastAssistant = event.seq;
        if (lastOursSeq > -1) assistantAfterOurs = true;
        break;
      case 'user/message':
        lastUser = event.seq;
        lastUserIsOurs = isOurContinueMessage(event, continueText);
        if (lastUserIsOurs) {
          lastOursSeq = event.seq;
          assistantAfterOurs = false;
          toolAfterOurs = false;
        }
        break;
      case 'tool/call': {
        const callId = event.data?.callId;
        if (callId !== undefined) pendingCalls.add(callId);
        if (lastOursSeq > -1) toolAfterOurs = true;
        break;
      }
      case 'tool/result': {
        const callId = toolResultCallId(event.data);
        if (callId !== undefined) pendingCalls.delete(callId);
        break;
      }
      default:
        break;
    }
  }

  const openTurn = lastTurnStart > lastTurnEnd;
  const openStep = lastStepStart > lastStepEnd;
  const pendingTool = pendingCalls.size > 0;
  const lastEvent = list[list.length - 1];
  const lastType = lastEvent?.type ?? null;

  const reasons = [];
  if (openTurn) reasons.push('open turn');
  if (openStep) reasons.push('open step');
  if (pendingTool) reasons.push(`${pendingCalls.size} pending tool call(s)`);

  if (lastType === 'assistant/message') {
    return { state: 'completed', reason: 'last event is assistant/message' };
  }
  if (reasons.length > 0) {
    return { state: 'interrupted', reason: reasons.join(' + ') };
  }
  if (lastTurnEndReason === 'interrupted') {
    return { state: 'interrupted', reason: 'last turn/end reason = interrupted' };
  }
  if (lastUser > lastTurnEnd) {
    // 闭合轮次之后又出现一条用户消息：可能是我们的上次注入还没被处理，也可能是用户手动输入。
    // 两种情况下都不再补发，避免同一会话堆积多条「继续」。
    return {
      state: lastUserIsOurs ? 'completed' : 'settled',
      reason: lastUserIsOurs
        ? 'previous autoresume prompt still pending'
        : 'pending user message after completed turn; not touching'
    };
  }
  if (lastTurnEndReason === 'error' && isNetworkFailure(lastTurnEndError)) {
    // 网络/瞬时故障停止（如 RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/upstream error），
    // 含账户余额类（QUOTA/402/Insufficient balance，2026-08-29 加入）：
    // 重试可恢复，注入「继续」让其自动重跑（2026-08-24 新增能力）。
    // 死循环守卫（2026-08-24）：若我们上次注入「继续」之后未产生任何内容/工具调用便再次
    // 以同类网络错误失败（模型持续空返回），判定为持续故障 → 转 settled 不注入，交由用户。
    const continuedThenFell = lastOursSeq > -1 && lastTurnEnd > lastOursSeq && !assistantAfterOurs && !toolAfterOurs;
    if (continuedThenFell) {
      return { state: 'settled', reason: `autoresume continue led to immediate network failure with no progress (loop guard): ${describeFailure(lastTurnEndError)}` };
    }
    return { state: 'network-stopped', reason: `last turn/end reason = error (network): ${describeFailure(lastTurnEndError)}` };
  }
  if (lastTurnEndReason === 'completed') {
    return { state: 'completed', reason: 'last turn/end reason = completed' };
  }
  return { state: 'settled', reason: `last turn/end reason = ${lastTurnEndReason ?? 'none'}; no mid-state` };
}

/** 需要注入「继续」的状态：被打断（interrupted）或网络/瞬时故障停止（network-stopped）。 */
function isResumableState(state) {
  return state === 'interrupted' || state === 'network-stopped';
}

export function buildContinueMessage(promptText = DEFAULT_PROMPT_TEXT) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: String(promptText) })]),
    source: Object.freeze({ kind: 'plugin', plugin: 'dsh-autoresume', form: 'notice', summary: NOTICE_SUMMARY })
  });
}

const SESSIONS_ROOT = join(process.env.HOME ?? homedir(), '.dsh', 'sessions');

function* enumerateSessions() {
  try {
    const roots = readdirSync(SESSIONS_ROOT, { withFileTypes: true });
    for (const root of roots) {
      if (!root.isDirectory()) continue;
      const sessRoot = join(SESSIONS_ROOT, root.name);
      let sessions;
      try { sessions = readdirSync(sessRoot, { withFileTypes: true }); } catch { continue; }
      for (const s of sessions) {
        if (!s.isDirectory()) continue;
        const file = join(sessRoot, s.name, 'session.jsonl.zstd');
        if (existsSync(file)) yield { sessionId: s.name, file };
      }
    }
  } catch { /* 目录不可读则空集 */ }
}

export function apply(ctx, config = {}) {
  // 单目标兼容：显式 targetSessionId → 旧行为；否则全域扫描（scanMode 默认 true）
  const targetSessionId = typeof config.targetSessionId === 'string' && config.targetSessionId !== ''
    ? config.targetSessionId
    : null;
  const scanMode = targetSessionId === null && config.scanMode !== false;
  const scanWindowMs = positiveInt(config.scanWindowMs, 86400000);
  // 2026-08-27：bootGraceMs 默认值由 30min 改为 Infinity（永久不 disarmed）。
  // 原因：429 受害者（如 17c2ce80「提示词润色插件开发」）可能 DSH 救不回来后会话被放弃、
  // mtime 静止 14h+；旧默认 30min 让 dsh-web 进程超窗后永远 disarmed，错过所有这类会话。
  // 永久不睡的代价由 liveWatch 的 lastSeenMtime 缓存吸收（mtime 不变就跳过，0 开销）。
  // 用户可显式配置 bootGraceMs 数值回归 30min 行为。
  const bootGraceMs = positiveInt(config.bootGraceMs, Number.POSITIVE_INFINITY);
  const initialDelayMs = positiveInt(config.initialDelayMs, 3000);
  const pollIntervalMs = positiveInt(config.pollIntervalMs, 5000);
  const promptText = typeof config.promptText === 'string' && config.promptText !== ''
    ? config.promptText
    : DEFAULT_PROMPT_TEXT;
  // liveWatch（默认 true）：boot 扫描后保持轮询，补 catch 运行期间的再次网络/瞬时失败。
  // 受 analyzeSessionEvents 的 loop-guard 约束（模型持续空返回时转 settled 不注入），避免死循环。
  // false 则回退旧的一次性 boot 行为（首批注入后 disarm）。
  const liveWatch = config.liveWatch !== false;

  const bootStartedAtMs = Date.now() - Math.floor(process.uptime() * 1000);
  let settled = false;
  let injected = false;
  let polls = 0;
  let intervalHandle = null;

  function finishDecision() {
    settled = true;
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  /** 与宿主 resolveSessionPreset 同语义：最后一个 agent-preset/selected 优先，否则取 header。 */
  function sessionPresetId(inspection) {
    const events = inspection?.events;
    if (Array.isArray(events)) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
          return event.data.agentPreset;
        }
      }
    }
    return typeof inspection?.meta?.agentPreset === 'string' ? inspection.meta.agentPreset : undefined;
  }

  /**
   * 与宿主 composeAgent 的 installSelection 同款：把会话持久化的模型选择装进
   * agent 上下文（system-prompt/assemble 注入 provider/model 变量，否则 prompt
   * 里的 {{model}} 组装报错；agent/request 也按此路由模型）。
   * 2026-08-22 实测暴露：只挂 preset 不装 selection → 「prompt variable
   * "{{model}}" has no value for this assembly (section "deployment:persona")」。
   */
  function installSessionSelection(agentCtx) {
    const agent = agentCtx.agent;
    let picked;
    const selection = {
      get current() {
        if (picked !== undefined) return picked;
        let logged;
        try {
          logged = agent?.session?.requestHeader?.()?.config;
        } catch {
          logged = undefined;
        }
        if (logged !== undefined) {
          return {
            provider: logged.provider,
            model: logged.model,
            ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort })
          };
        }
        try {
          return ctx.get('agentDefaultModel')?.currentSelection?.() ?? undefined;
        } catch {
          return undefined;
        }
      },
      set current(next) {
        picked = next;
      }
    };
    installModelSelection(agent.ctx, selection);
  }

  /**
   * 2026-08-22 运维修复：目标会话 agent 不在线时由插件自己 resume（挂上会话的
   * preset 组成 + 模型选择，与浏览器打开同构），不再依赖用户手动打开会话。
   */
  async function resumeSession(sessionId) {
    let setup;
    try {
      const presets = ctx.get('agentPresets');
      if (presets !== undefined) {
        const inspection = await ctx.sessionPersistence.inspect(sessionId);
        const presetId = sessionPresetId(inspection);
        if (presetId !== undefined) {
          const resolved = await presets.resolve(presetId);
          setup = async (agentCtx) => {
            installSessionSelection(agentCtx);
            await presets.mount(agentCtx, resolved.id);
          };
        } else {
          setup = async (agentCtx) => { installSessionSelection(agentCtx); };
        }
      } else {
        setup = async (agentCtx) => { installSessionSelection(agentCtx); };
      }
    } catch (error) {
      setup = undefined;
      ctx.logger.warn(`dsh-autoresume: preset compose for ${sessionId} failed, plain resume fallback: ${String(error?.message ?? error)}`);
    }
    await ctx.agents.resume({
      resumeSessionId: sessionId,
      ...(setup === undefined ? {} : { setup })
    });
  }

  // per-session 早期路径串行化（防并发抢先 resume 竞态，2026-08-22 教训）
  const earlyPromises = new Map();

  function runEarlyPath(sessionId) {
    if (earlyPromises.has(sessionId)) return earlyPromises.get(sessionId);
    const p = (async () => {
      let analysis;
      try {
        const inspection = await ctx.sessionPersistence.inspect(sessionId);
        analysis = analyzeSessionEvents(inspection.events, promptText);
        console.error(`[dsh-autoresume] early inspect ${sessionId} state=${analysis.state} reason=${analysis.reason}`);
      } catch (error) {
        ctx.logger.warn(`dsh-autoresume: early inspect(${sessionId}) failed: ${String(error?.message ?? error)}`);
        throw error;
      }
      if (!isResumableState(analysis.state)) return;
      try {
        // 先入待注入集合再 resume：session-start 事件在 resume resolve 前触发，
        // 若事后 add 会造成 candidates=[] → 误 disarm（2026-08-23 竞态修复）
        pendingResume.add(sessionId);
        await resumeSession(sessionId);
        console.error(`[dsh-autoresume] self-resumed ${sessionId}`);
      } catch (error) {
        pendingResume.delete(sessionId);
        ctx.logger.warn(`dsh-autoresume: resume(${sessionId}) failed: ${String(error?.message ?? error)}`);
        throw error;
      }
    })();
    earlyPromises.set(sessionId, p);
    return p.catch(() => { earlyPromises.delete(sessionId); });
  }

  const pendingResume = new Set();

  /** 候选会话：单目标模式=仅 target；全域模式=窗口内（最后活动 >= boot-窗口）的全部会话。 */
  function candidateSessions() {
    if (targetSessionId !== null) {
      // 单目标兼容：仍读真实 mtime，便于 liveWatch 在运行期间再次失败时也能补 catch。
      for (const s of enumerateSessions()) {
        if (s.sessionId === targetSessionId) {
          try { return [{ id: targetSessionId, mtime: statSync(s.file).mtimeMs }]; } catch { break; }
        }
      }
      return [{ id: targetSessionId, mtime: -1 }];
    }
    const cutoff = bootStartedAtMs - scanWindowMs;
    const out = [];
    for (const s of enumerateSessions()) {
      try {
        const mtime = statSync(s.file).mtimeMs;
        if (mtime >= cutoff) out.push({ id: s.sessionId, mtime });
      } catch { /* 忽略不可读 */ }
    }
    return out;
  }

  /** 每会话上次扫描到的 mtime：live 轮询据此跳过未变化的会话，避免反复读大事件流。 */
  const lastSeenMtime = new Map();

  async function checkOnce(source) {
    if (settled) return;
    polls += 1;
    // 2026-08-27：bootGraceMs 默认 Infinity（永不触发）——守护程序永久不睡。
    // 旧默认 30min 导致进程超窗后永远 disarmed、错过 14h+ 前的 429 受害者会话。
    // 用户可显式配 bootGraceMs 数值回归旧行为。
    if (Date.now() - bootStartedAtMs > bootGraceMs) {
      finishDecision();
      ctx.logger.info(`dsh-autoresume: boot grace expired (${source}) — disarmed for this process`);
      console.error(`[dsh-autoresume] boot grace expired (${source}) — disarmed for this process`);
      return;
    }
    // 首轮=窗口内全景候选；后续轮（liveWatch 开启时）=同样重扫全部候选，但仅 mtime 变化过的会话。
    const base = candidateSessions();
    const candidates = new Set();
    for (const c of base) {
      const last = lastSeenMtime.get(c.id);
      if (polls <= 1 || last === undefined || c.mtime !== last) candidates.add(c.id);
      lastSeenMtime.set(c.id, c.mtime);
    }
    for (const id of pendingResume) candidates.add(id);
    for (const sessionId of candidates) {
      const agent = ctx.agents.get(sessionId);
      if (agent === undefined) {
        // agent 未 live：直读持久化流判定，被打断则自行 resume（持续在 pendingResume 待注入）
        await runEarlyPath(sessionId);
        continue;
      }
      if (agent.status !== 'idle') { console.error(`[dsh-autoresume] poll wait: ${sessionId} status=${agent.status}`); continue; }
      let inspection;
      try {
        inspection = await ctx.sessionPersistence.inspect(sessionId);
      } catch (error) {
        ctx.logger.warn(`dsh-autoresume: inspect(${sessionId}) failed: ${String(error?.message ?? error)}`);
        continue;
      }
      const analysis = analyzeSessionEvents(inspection.events, promptText);
      console.error(`[dsh-autoresume] ${sessionId} state=${analysis.state} reason=${analysis.reason} source=${source}`);
      if (!isResumableState(analysis.state)) { pendingResume.delete(sessionId); continue; }
      try {
        agent.send(buildContinueMessage(promptText), 'next-turn', true);
        injected = true;
        pendingResume.delete(sessionId);
        ctx.logger.info(`dsh-autoresume: injected「${promptText}」into ${sessionId}`);
      } catch (error) {
        ctx.logger.warn(`dsh-autoresume: inject into ${sessionId} failed: ${String(error?.message ?? error)}`);
      }
    }
    // 旧一次性行为（liveWatch 关闭）：所有候选均已闭环（判定完成或注入完成）才 disarm。
    if (!liveWatch && pendingResume.size === 0) finishDecision();
  }

  // ② 会话 agent 就绪事件：直接对「待注入」会话执行注入（不等 poll 轮）
  async function injectIfIdle(sessionId) {
    if (!pendingResume.has(sessionId)) return;
    const agent = ctx.agents.get(sessionId);
    if (agent === undefined) { console.error(`[dsh-autoresume] inject wait: ${sessionId} agent not live yet`); return; }
    if (agent.status !== 'idle') { console.error(`[dsh-autoresume] inject wait: ${sessionId} agent status=${agent.status}`); return; }
    let inspection;
    try { inspection = await ctx.sessionPersistence.inspect(sessionId); }
    catch (error) { ctx.logger.warn(`dsh-autoresume: inject inspect(${sessionId}) failed: ${String(error?.message ?? error)}`); return; }
    const analysis = analyzeSessionEvents(inspection.events, promptText);
    console.error(`[dsh-autoresume] inject check ${sessionId} state=${analysis.state}`);
    if (!isResumableState(analysis.state)) { pendingResume.delete(sessionId); console.error(`[dsh-autoresume] inject skip: ${sessionId} state=${analysis.state}`); return; }
    try {
      agent.send(buildContinueMessage(promptText), 'next-turn', true);
      injected = true;
      pendingResume.delete(sessionId);
      console.error(`[dsh-autoresume] injected「${promptText}」into ${sessionId}`);
    } catch (error) {
      ctx.logger.warn(`dsh-autoresume: inject into ${sessionId} failed: ${String(error?.message ?? error)}`);
    }
  }

  ctx.effect(() => {
    const initial = setTimeout(() => { void checkOnce('initial'); }, initialDelayMs);
    intervalHandle = setInterval(() => { void checkOnce('poll'); }, pollIntervalMs);
    const off = ctx.on('agent/session-start', (payload) => {
      const id = payload?.agent?.session?.id ?? payload?.agent?.id;
      if (id !== undefined) {
        console.error('[dsh-autoresume] agent/session-start observed: ' + id);
        if (pendingResume.has(id)) { void injectIfIdle(id); } else { void checkOnce('agent/session-start'); }
      }
    });
    return () => {
      clearTimeout(initial);
      if (intervalHandle !== null) clearInterval(intervalHandle);
      off();
    };
  }, 'dsh-autoresume: boot-time watcher');
}
