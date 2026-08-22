/**
 * dsh-autoresume：web 启动后只对固定的开发会话做一次「重启打断检测」，
 * 若持久化事件流停在 turn/start 或 tool/ 调用链中间态且没有 assistant 完成回复，
 * 就通过 agent.followup() 注入一条「继续」。只服务 targetSessionId 一个会话。
 */
import { randomUUID } from 'node:crypto';
import { installModelSelection } from '@deepseek-ai/dsh-agent';

export const name = 'dsh-autoresume';
export const inject = ['agents', 'sessions', 'sessionPersistence'];

const DEFAULT_TARGET_SESSION_ID = '';
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
 * 对持久化事件流做一次性状态判定：
 * - completed：最后是 assistant 完成回复，或最后一个 turn/end 已完成且其后没有新用户消息；
 * - interrupted：turn/step 打开未闭合、存在无结果的 tool/call、或最后一个 turn/end 原因为 interrupted；
 * - settled：有闭合边界但既非 completed 也非 interrupted（如 cancelled/error），不动作避免注入循环；
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
  const pendingCalls = new Set();

  for (const event of list) {
    switch (event?.type) {
      case 'turn/start':
        lastTurnStart = event.seq;
        break;
      case 'turn/end':
        lastTurnEnd = event.seq;
        lastTurnEndReason = event.data?.reason?.kind ?? null;
        break;
      case 'step/start':
        lastStepStart = event.seq;
        break;
      case 'step/end':
        lastStepEnd = event.seq;
        break;
      case 'assistant/message':
        lastAssistant = event.seq;
        break;
      case 'user/message':
        lastUser = event.seq;
        lastUserIsOurs = isOurContinueMessage(event, continueText);
        break;
      case 'tool/call': {
        const callId = event.data?.callId;
        if (callId !== undefined) pendingCalls.add(callId);
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
  if (lastTurnEndReason === 'completed') {
    return { state: 'completed', reason: 'last turn/end reason = completed' };
  }
  return { state: 'settled', reason: `last turn/end reason = ${lastTurnEndReason ?? 'none'}; no mid-state` };
}

export function buildContinueMessage(promptText = DEFAULT_PROMPT_TEXT) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: String(promptText) })]),
    source: Object.freeze({ kind: 'plugin', plugin: 'dsh-autoresume', form: 'notice', summary: NOTICE_SUMMARY })
  });
}

export function apply(ctx, config = {}) {
  const targetSessionId = typeof config.targetSessionId === 'string' && config.targetSessionId !== ''
    ? config.targetSessionId
    : DEFAULT_TARGET_SESSION_ID;
  if (targetSessionId === '') {
    ctx.logger.warn('dsh-autoresume: no targetSessionId configured — plugin disarmed; set config.targetSessionId');
    return;
  }
  const bootGraceMs = positiveInt(config.bootGraceMs, 1800000);
  const initialDelayMs = positiveInt(config.initialDelayMs, 3000);
  const pollIntervalMs = positiveInt(config.pollIntervalMs, 5000);
  const promptText = typeof config.promptText === 'string' && config.promptText !== ''
    ? config.promptText
    : DEFAULT_PROMPT_TEXT;

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
  async function resumeTargetAgent() {
    let setup;
    try {
      const presets = ctx.get('agentPresets');
      if (presets !== undefined) {
        const inspection = await ctx.sessionPersistence.inspect(targetSessionId);
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
      ctx.logger.warn(`dsh-autoresume: preset compose for ${targetSessionId} failed, plain resume fallback: ${String(error?.message ?? error)}`);
    }
    await ctx.agents.resume({
      resumeSessionId: targetSessionId,
      ...(setup === undefined ? {} : { setup })
    });
  }

  /**
   * 早期路径（agent 不在线时）：读持久化流判定 → 被打断才自己 resume。
   * 用共享 promise 串行化，避免并发 checkOnce 在判定落地前抢先 resume
   * （2026-08-22 修复：曾出现 completed 判定后仍 self-resumed 的竞态）。
   */
  let earlyPathPromise = null;

  function runEarlyPath() {
    earlyPathPromise ??= (async () => {
      let analysis;
      try {
        const inspection = await ctx.sessionPersistence.inspect(targetSessionId);
        analysis = analyzeSessionEvents(inspection.events, promptText);
        ctx.logger.info(`dsh-autoresume: early inspect ${targetSessionId} state=${analysis.state} reason=${analysis.reason}`);
        console.error(`[dsh-autoresume] early inspect state=${analysis.state} reason=${analysis.reason}`);
      } catch (error) {
        ctx.logger.warn(`dsh-autoresume: early inspect(${targetSessionId}) failed: ${String(error?.message ?? error)}`);
        throw error;
      }
      if (analysis.state !== 'interrupted') {
        finishDecision();
        return;
      }
      try {
        await resumeTargetAgent();
        ctx.logger.info(`dsh-autoresume: self-resumed ${targetSessionId}`);
        console.error(`[dsh-autoresume] self-resumed ${targetSessionId}`);
      } catch (error) {
        ctx.logger.warn(`dsh-autoresume: resume(${targetSessionId}) failed: ${String(error?.message ?? error)}`);
        throw error;
      }
    })();
    return earlyPathPromise.catch(() => { earlyPathPromise = null; });
  }

  async function checkOnce(source) {
    if (settled || injected) return;
    polls += 1;
    // 只在 web 进程真正重启后的宽限窗口内行动；profile HMR 装/卸插件不会拿到新进程。
    if (Date.now() - bootStartedAtMs > bootGraceMs) {
      finishDecision();
      ctx.logger.info(`dsh-autoresume: boot grace expired (${source}) — disarmed for this process`);
      console.error(`[dsh-autoresume] boot grace expired (${source}) — disarmed for this process`);
      return;
    }
    const agent = ctx.agents.get(targetSessionId);
    if (agent === undefined) {
      // 目标会话 agent 尚未 live：不再干等——先读持久化流判定状态（无需 agent 在线），
      // 若被打断则自己 resume 目标会话，下一轮 poll 走下方注入路径。
      await runEarlyPath();
      return;
    }
    if (agent.status !== 'idle') return; // 正在运行，绝不打断
    console.error(`[dsh-autoresume] check ${source}: target agent live and idle`);
    let inspection;
    try {
      inspection = await ctx.sessionPersistence.inspect(targetSessionId);
    } catch (error) {
      ctx.logger.warn(`dsh-autoresume: inspect(${targetSessionId}) failed: ${String(error?.message ?? error)}`);
      return;
    }
    finishDecision(); // 每个进程只判定/注入一次
    const analysis = analyzeSessionEvents(inspection.events, promptText);
    ctx.logger.info(`dsh-autoresume: ${targetSessionId} state=${analysis.state} reason=${analysis.reason} source=${source}`);
    console.error(`[dsh-autoresume] ${targetSessionId} state=${analysis.state} reason=${analysis.reason} source=${source}`);
    if (analysis.state !== 'interrupted') return;
    try {
      agent.followup(buildContinueMessage(promptText));
      injected = true;
      ctx.logger.info(`dsh-autoresume: injected「${promptText}」into ${targetSessionId}`);
    } catch (error) {
      ctx.logger.warn(`dsh-autoresume: inject into ${targetSessionId} failed: ${String(error?.message ?? error)}`);
    }
  }

  ctx.effect(() => {
    const initial = setTimeout(() => { void checkOnce('initial'); }, initialDelayMs);
    intervalHandle = setInterval(() => { void checkOnce('poll'); }, pollIntervalMs);
    const off = ctx.on('agent/session-start', (payload) => {
      const id = payload?.agent?.session?.id ?? payload?.agent?.id;
      if (id === targetSessionId) {
        console.error('[dsh-autoresume] agent/session-start observed for target');
        void checkOnce('agent/session-start');
      }
    });
    return () => {
      clearTimeout(initial);
      if (intervalHandle !== null) clearInterval(intervalHandle);
      off();
    };
  }, 'dsh-autoresume: boot-time watcher');
}
