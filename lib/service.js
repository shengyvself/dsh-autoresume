/**
 * dsh-autoresume：web 重启后对**任一被重启打断的会话**做一次「自动继续」。
 * scanMode=true（默认）时扫描 ~/.dsh/sessions 下所有会话（仅处理最后活动在
 * scanWindowMs 窗口内的），持久化事件流停在中间态（open turn/无结果 tool call/
 * interrupted）或**网络故障停止**（最后 turn/end 为可重试错误码/网络特征消息，
 * 含账户余额类 QUOTA/402/Insufficient balance——充值或换 provider 后可恢复）
 * 才注入「继续」；completed/settled 一律不动。保留单目标兼容：
 * 配置 targetSessionId 时只服务该会话（旧行为）。
 * 402/余额类无限循环守卫（2026-09-01）：余额不足是**持久性**状态（充值/换
 * provider 前每次 LLM 调用必失败），注入一次后若再次以余额类错误失败 → 转
 * settled 不再注入（首次 402 仍注入一次以覆盖「充值后恢复」场景；防真没余额
 * 时无限自动继续）。
 * tpm/rpm 限流（2026-09-02）：sensenova 429 直出 `code=insufficient_quota,
 * type=rate_limit_error, message="inference exceeds tpm/rpm limit"`——限流窗口
 * 重置后可恢复，属瞬时网络故障 → 判 network-stopped 注入（非余额类；原被
 * 三路特征全漏判 settled 不注入）。注入后仍靠 loop-guard 防无产出死循环。
 *
 * 2026-09-13（DSH 0.1.5-rc.2 适配 + 队列行为 bug 修复）：
 * ① 队列守卫（pending-input）——inbox 里若有**别人**（用户/客户端）的挂起消息，一律
 *    不动作（既不注入也不 resume）：注入走 send(..., wakeup=true)，会唤醒 driver 把挂起的
 *    用户消息一并冲进会话；而「继续未完成的任务」自己则排在那批消息之后，表现为"进入排队"不执行。
 *    判据双路：持久化流的 agent/inbox/spliced 折叠（未 resume 路径）＋ 活体 agent.inbox
 *    .nextTurn/.nextStep（已在线路径）。
 * ② 会话日志代际——0.1.5-rc.2 的 SESSION_FORMAT_VERSION=3，新会话写 session.v3.jsonl.zstd，
 *    旧文件 session.jsonl.zstd 是历史代际；枚举须按代际取最高（原先只认旧名 → 0.1.5 下扫不到会话）。
 *
 * 2026-09-21（分类收敛：用户手动停止是终态 + 工具请求不是终结回复）：
 * ① 缺陷 B（用户明示「绝对的 bug」）——用户手动停止会触发自动继续。根因：`aborted` 是驱动**主动
 *    收尾**（cancel 的 finally 写出 turn/end、边界闭合），与「环境杀死进程」（turn/end 缺失、
 *    open turn）本质不同；旧代码见 open step / 无结果 tool/call 一律判 interrupted 并注入「继续」，
 *    等于推翻用户指令。修复：悬挂边界只在**轮次仍打开**时才算「这轮没干完」，闭合轮次一律落到
 *    turn/end 原因判定；并新增显式 `aborted` 分支判 settled（reason 标出动因 user/disposed）。
 * ② 缺陷 A——工具调用被中断于「记录为开始」之前时自动继续完全不生效。根因：宿主补写
 *    ToolNotStartedError 的 tool/result（"...interrupted before the Harness recorded it as started.
 *    Retry it if it is still needed."），而上一条 assistant/message 是**未执行**的工具请求，轮次
 *    并未结束；旧代码见 lastType==='assistant/message' 一律判 completed（终态）。修复：含 tool-call
 *    块的 assistant/message 不落 completed，交给 open turn 判定接手（messageHasToolCall）。
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal';

export const name = 'dsh-autoresume';
export const inject = ['agents', 'sessions', 'sessionPersistence'];

const DEFAULT_TARGET_SESSION_ID = 'session-00000000-0000-0000-0000-000000000000';
const DEFAULT_PROMPT_TEXT = '继续未完成的任务';
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

/** assistant/message 是否含 tool-call 块——含则是「工具请求」而非终结回复。
 * 2026-09-21（缺陷 A）：宿主在工具调用被中断于「记录为开始」之前时补写 ToolNotStartedError 的
 * tool/result（"The tool call was interrupted before the Harness recorded it as started.
 * Retry it if it is still needed."）——此时上一条 assistant/message 是**未执行**的工具请求，
 * 轮次并未结束。旧代码见 lastType==="assistant/message" 一律判 completed（终态），该情况的
 * 自动继续完全不生效（用户实报「自动继续对以下情况没有生效」）。 */
function messageHasToolCall(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return false;
  return blocks.some(block => block && typeof block === 'object' && block.type === 'tool-call');
}

/** 一条 UserMessage 是否是我们自己注入的「继续」消息（user/message 事件与 inbox 挂起项同构）。 */
function isOurMessage(message, continueText = DEFAULT_PROMPT_TEXT) {
  const source = message?.source;
  if (!source || source.kind !== 'plugin' || source.plugin !== 'dsh-autoresume') return false;
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return false;
  return blocks.some(block => block && block.type === 'text' && block.text === continueText);
}

function isOurContinueMessage(event, continueText = DEFAULT_PROMPT_TEXT) {
  return isOurMessage(event?.data, continueText);
}

/** 一个 inbox 目标列表的耐久表示（与 dsh-agent/types 的 InboxState 同构）。 */
function emptyInboxState() {
  return { 'next-turn': [], 'next-step': [] };
}

/**
 * 按 dsh-agent 的 agent/inbox/spliced 语义折叠一次挂起消息变更：
 * { target, start, removedCount?, inserted, outcome? } —— 与宿主 session-projection
 * 的 inbox 投影同款（append = splice(len, 0, [m])；claim = 按 removedCount 删除）。
 */
export function applyInboxSplice(state, data) {
  const target = data?.target;
  if (target !== 'next-turn' && target !== 'next-step') return state;
  const list = state[target];
  const start = Number.isFinite(data?.start) ? Math.max(0, Math.trunc(data.start)) : list.length;
  const removed = Number.isFinite(data?.removedCount) ? Math.max(0, Math.trunc(data.removedCount)) : 0;
  const inserted = Array.isArray(data?.inserted) ? data.inserted : [];
  list.splice(Math.min(start, list.length), removed, ...inserted);
  return state;
}

/** 从完整事件流折叠出 inbox 挂起状态（导出供测试）。 */
export function foldPendingInbox(events) {
  const state = emptyInboxState();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'agent/inbox/spliced') applyInboxSplice(state, event.data);
  }
  return state;
}

/**
 * DSH dsh-llm 官方可重试错误码（= 瞬时/网络类故障，重试可恢复），见
 * @deepseek-ai/dsh-llm retry-policy DEFAULT_RETRYABLE_CODES。
 */
const RETRYABLE_LLM_CODES = new Set(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'rate_limit_exceeded', 'too_many_requests', 'QUOTA', 'insufficient_balance', 'payment_required', 'insufficient_quota']);

/** DSH API 直出瞬时/上游错误 type（实证 service_unavailable；server_error 为 5xx 标准语义）。
 * 2026-09-02 追加 rate_limit_error——sensenova 429 直出 `type=rate_limit_error`（code=insufficient_quota,
 * message="inference exceeds tpm/rpm limit"），限流窗口重置后可恢复，属瞬时错误应注入。
 * 2026-09-08 追加 quota_exceeded_error——sensenova「日日新」429 另一形态 `type=quota_exceeded_error,
 * code="8", message="rpm exhausted"`（rpm 达上限，限流窗口重置可恢复），同属瞬时限流应注入。 */
const RETRYABLE_LLM_TYPES = new Set(['service_unavailable', 'server_error', 'rate_limit_error', 'quota_exceeded_error']);

/**
 * 余额类（持久性）错误：账户余额不足/配额耗尽——充值或换 provider 前每次 LLM
 * 调用都必然失败，与瞬时网络故障（429/5xx）性质不同。2026-09-01 新增：
 * 注入「继续」后再次以余额类错误失败 → 判 settled 防无限循环。
 * 错误形态实证：{"message":"402 status code (no body)","code":"PI_AI_ERROR"}
 * 与 {"code":"QUOTA","message":"402 {\"error\":\"Insufficient balance\"}"}。
 * 2026-09-02 修正：insufficient_quota 移入 RETRYABLE_LLM_CODES——sensenova 用该码表达
 * tpm/rpm 限流（type=rate_limit_error、message="inference exceeds tpm/rpm limit"），
 * 是限流窗口性瞬时错误而非余额不足（实测可随窗口重置恢复），不属余额类。
 */
const BALANCE_LLM_CODES = new Set(['QUOTA', 'insufficient_balance', 'payment_required', 'payment_required_to_access']);

/** 余额类消息特征（与 NETWORK_FAILURE_PATTERN 中余额子集一致，单独抽出便于归类）。
 * PATCH 2026-09-18：补火山/商汤的周级额度硬限制签名。
 *  - 火山 Ark：`429: {"code":"AccountQuotaExceeded","message":"You have exceeded the weekly usage quota.
 *    It will reset at 2026-09-21 00:00:00 +0800 CST"}`——周额度耗尽，数天后才重置，非瞬时限流。
 *    实证：Lynn&Shengyv 会话日志内 `AccountQuotaExceeded` ×142 / `weekly usage quota` ×122。
 *  - 商汤：5 位错误码 80003/80004（日志内确有 2 处出现），用 \b 边界避免误命中普通数字。
 */
const BALANCE_FAILURE_PATTERN = /(\b402\b|insufficient balance|payment required|quota exceeded|quota exhausted|no balance|insufficient funds|accountquotaexceeded|weekly usage quota|will reset at|\b80003\b|\b80004\b)/i;

/** 限流类消息特征（与余额仲裁前置）：429/rate_limit/too many requests/tpm·rpm/insufficient_quota。
 * 2026-09-08 实证：DSH 把 sensenova 429 包装成外层 code=QUOTA + message 内嵌
 * `429: {"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"insufficient_quota"}`——
 * code 多义（QUOTA 同时承载"余额不足"与"限流"语义），须按消息特征先排除限流，
 * 否则限流被误判余额 → 注入后无限不注入。余额语义仍由 BALANCE_LLM_CODES/402 特征覆盖。
 * 2026-09-08（二）：Sensenova「日日新」加码 rpm/tpm exhausted 形态——`"message":"rpm exhausted"`。
 */
const RATE_LIMIT_MESSAGE_PATTERN = /(\b429\b|too many requests|rate[-_ ]?limit|rate_limit_error|tpm\/rpm|rpm exhausted|tpm exhausted|insufficient_quota|quota_exceeded)/i;

/** 判定 turn/end 错误是否属于余额类（持久性，非瞬时）。 */
function isBalanceFailure(error) {
  const inner = unwrapError(error);
  if (!inner || typeof inner !== 'object') return false;
  const code = typeof inner.code === 'string' ? inner.code : '';
  const message = typeof inner.message === 'string' ? inner.message : '';
  // PATCH 2026-09-18（火山周额度误判修复）：余额特征优先于限流仲裁。
  // 原顺序（2026-09-08，限流先于余额）是为 sensenova 429 被包装成 code=QUOTA 而设计——其 message
  // 含 `insufficient_quota`（下划线），与本正则的 `quota exceeded`/`quota exhausted` 均不匹配，
  // 故可安全地让限流先仲裁。但火山周额度耗尽的 message 以 `429:` 开头，命中 RATE_LIMIT_MESSAGE_PATTERN
  // 的 \b429\b，被误判为可重试瞬时限流（可注入）；其实际是周级硬额度（`It will reset at` 数天后）。
  // 实证后果：Lynn&Shengyv 会话 09-17→09-18 被自激注入 15 次，22 个 error turn 全为该类 429。
  // 现将余额特征前置：命中即判持久故障，不再让 \b429\b 拉回限流；sensenova 限流路径不受影响
  // （其 message 不含任何新增余额签名，仍走 RATE_LIMIT_MESSAGE_PATTERN → return false）。
  if (BALANCE_FAILURE_PATTERN.test(message)) return true;
  if (RATE_LIMIT_MESSAGE_PATTERN.test(message)) return false;
  if (BALANCE_LLM_CODES.has(code)) return true;
  return false;
}

/**
 * assistant/chunk 的真实产出块类型。2026-09-01：usage/finish 是 LLM 调用的
 * 计费/结束元数据，不是模型产出——402 等请求被拒时也会先写 usage/finish 收尾，
 * 若计入「注入后进展」会让 loop-guard 的 !assistantAfterOurs 条件永不满足，
 * 造成「真没余额时自动继续无限循环」（实证：401860fc 注入→402→再注入×9）。
 */
const PROGRESS_CHUNK_TYPES = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta', 'block-start', 'block-end']);

function isProgressChunk(event) {
  const chunk = event?.data?.chunk;
  return chunk !== null && typeof chunk === 'object' && PROGRESS_CHUNK_TYPES.has(chunk.type);
}

/** 永久/配置类错误码：即使 message 命中网络特征（如 "400 status code (no body)"）也不判可重试。
 * 2026-09-01：400 加入网络特征后，CONTEXT_WINDOW_EXCEEDED（上下文超限，重试必失败，
 * 需用户手动压缩/换模型，CHANGELOG 0.0.12 回归基线 settled）与 UNKNOWN_MODEL 等
 * 可能携带同样 message——先于特征匹配排除，保回归。 */
const PERMANENT_LLM_CODES = new Set(['UNKNOWN_MODEL', 'MISSING_CREDENTIAL', 'NO_ADAPTER', 'INVALID_MODEL_INFO', 'CONTEXT_WINDOW_EXCEEDED', 'MODEL_NOT_FOUND']);

/** 兜底消息特征：官方码集合外但消息明确为瞬时网络/上游故障（如 PI_AI_ERROR: Upstream error…）。
 * 2026-08-31 追加：OpenRouter 上游 provider 故障标准文案 "Provider returned error"
 * （pi-ai adapter 兜底归类 PI_AI_ERROR，实证 minimax via openrouter 78s 无产出即此类；
 * 同 provider 稍后手动继续即成功 → 瞬时上游故障，应注入）。
 * 2026-09-01 追加：\b400\b（tokenrhythm/pi-ai 适配器兜底形态 "400 status code (no body)"——
 * 用户裁定 400 与 402 同为可继续错误：瞬时请求被拒/上游 4xx 可恢复，应注入；
 * 循环由 loop-guard 兜底（注入后再次失败无产出 → settled）。
 * 2026-09-01 追加（二）：中文瞬时特征——用户实报 tokenrhythm 返回
 * "模型服务暂时不可用，请稍后重试"（0 tok 即时失败，语义等同 service temporarily
 * unavailable / please try again later）→ 判 network-stopped 注入；
 * 循环由 loop-guard 兜底。
 * 2026-09-02 追加：tpm/rpm 限流消息特征——sensenova 429 直出 message
 * "inference exceeds tpm/rpm limit"（type=rate_limit_error、code=insufficient_quota），
 * 限流窗口重置后可恢复，属瞬时可重试；同时覆盖 "rate limit"/"rate_limit"
 * 文字形态（部分 provider 仅消息无码）。循环由 loop-guard 兜底。
 * 注意：CONTEXT_WINDOW_EXCEEDED 等永久码由 PERMANENT_LLM_CODES 先行排除。 */

const NETWORK_FAILURE_PATTERN = /(upstream error|internal server error|service temporarily unavailable|currently overloaded|please try again later|all endpoints are currently overloaded|provider returned error|模型服务暂时不可用|服务暂时不可用|暂时不可用|请稍后重试|稍后再试|当前繁忙|服务器繁忙|\b400\b|\b429\b|\b402\b|\b5\d\d\b|gateway time-?out|timed\s?out|fetch failed|econnreset|econnrefused|etimedout|socket hang up|network error|connection\s+(?:refused|reset|closed)|insufficient balance|payment required|payment required to access|quota exceeded|quota exhausted|tpm\/rpm|rpm exhausted|tpm exhausted|rate\s?limit|rate_limit)/i;

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
  // 2026-09-01：永久/配置类错误码先行排除——即使 message 命中网络特征
  // （如 CONTEXT_WINDOW_EXCEEDED 携带 "400 status code (no body)"）也判非网络，
  // 保 CHANGELOG 0.0.12 回归基线（上下文超限 settled 不注入）。
  if (PERMANENT_LLM_CODES.has(code)) return false;
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
export function analyzeSessionEvents(events, continueText = DEFAULT_PROMPT_TEXT, maxResumeAttempts = 2, options = {}) {
  const skipWhenInputPending = options?.skipWhenInputPending !== false;
  // 2026-09-20（重启循环守卫的**时限重武装**）：置位须同时满足「环境在置位后交付过真实产出」
  // 与「距置位 ≥ 本时限」才解除。默认 **10min**——阈值由两个真实会话的间隔实测定档：
  //   必须拦（环境仍不稳定）：a7d1a7da 置位 17:32:35 → turn7 17:42:26 = 9.85min
  //                           de07a006 置位 20:43:07 → turn3 20:46:30 = 3.38min（循环 20:46:53 才停）
  //   必须放行（循环已停）  ：de07a006 置位 20:43:07 → turn4 20:54:52 = 11.75min
  //                           de07a006 置位 20:43:07 → turn5 21:06:05 = 22.97min
  // 5min 阈会误放 a7d1a7da 的 17:42:26（重引入 §一百三十五 已切断的注入），10min 四例全对。
  const restartLoopDecayMs = positiveInt(options?.restartLoopDecayMs, 600000);
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
  // 2026-09-21（缺陷 B）：aborted 的**动因**（user＝用户按停止键 / disposed＝生命周期拆除）。
  // aborted 是驱动**主动收尾**（cancel 的 finally 写出 turn/end、边界闭合），与「环境杀死进程」
  // （turn/end 缺失）本质不同——用户手动停止必须是终态，不得自动继续。
  let lastTurnEndCause = null;
  // 自动继续死循环守卫：跟踪我们上次注入「继续」之后是否产生了内容/工具调用。
  let lastOursSeq = -1;
  let assistantAfterOurs = false;
  let toolAfterOurs = false;
  // 2026-09-08：注入后连续「无产出网络失败」次数（failStreak）。商汤日日新（sensenova）
  // 限流窗口长、常连续两次 429（rpm exhausted / tpm-rpm limit）——用户裁决允许**连续两次**
  // 自动继续（maxResumeAttempts 默认 2）：注入后第一次无产出失败仍允许再注入一次，
  // 第二次才转 settled 防死循环。余额类（isBalanceFailure）保持一次即停（持久性，§五十四）。
  let failStreak = 0;
  // 2026-09-20（重启循环守卫持久化）：我们的「继续」被杀死且**零产出**的判据，
  // 从「最后一条用户消息是我们」改为流内累计的布尔态——用户自己打「继续」被杀死会翻转
  // lastUserIsOurs，使旧判据对其后所有注入永久失效（实证 session-a7d1a7da 全量 578 事件：
  // 16:29 用户原始消息 → 16:39 第 2 次注入零产出被杀 → 17:30 起用户三次打「继续」，
  // 插件紧随其后又注入 6 次（17:31/17:32/17:48/17:52/17:55×2），6 次全部零产出或纯重复
  // 用户的「继续」，会话一次都没被真正拉起——用户报「自动继续注入了却没有拉起会话」）。
  // 结算规则见 turn/end 分支。re-arm 信号有两条：
  //   ① 任意轮次 completed（环境交付了完成的轮次，最强信号）；
  //   ② 时限重武装——置位后环境交付过**真实产出**的轮次、且距置位 ≥ restartLoopDecayMs。
  // ② 的由来（2026-09-20 用户报「自动继续没有拉起会话继续任务」）：只有 ① 会死锁——
  // 被反复打断的会话恰恰永远产生不了 completed（本会话 6 轮全 interrupted/aborted），
  // 于是「守卫武装 → 不注入 → 不 completed → 不解除」自我锁死：20:43:07 置位后连续 8 次
  // 判定被拦，含 20:55:08（置位后 11.75min）与 21:06:25（22.97min）两次真实中断，用户最终
  // 只能手打插件自己的消息「继续未完成的任务」（seq 154）。
  // 「有产出又被 interrupted 不足以证明环境稳定」的顾虑由时限兜住：重启循环的杀死间隔是
  // 秒级（本会话观测 12–35s 一轮），置位后 5min 内出现产出仍视为循环未停。
  let hasKilledNoProgress = false;
  let killedNoProgressSeq = -1;   // 置位那条 turn/end 的 seq（产出比较的基准点）
  let killedNoProgressTime = -1;  // 置位那条 turn/end 的时间戳（时限比较的基准点）
  let lastProgressSeq = -1;       // 最后一次真实产出（assistant/message、进度型 chunk、tool/call）
  let pendingOursSeq = -1;   // 上一条「继续」注入的 seq（其 turn/end 尚未结算）
  const pendingCalls = new Set();
  // 2026-09-13：inbox 挂起项折叠（队列守卫的持久化判据）。
  const pendingInbox = emptyInboxState();

  for (const event of list) {
    switch (event?.type) {
      case 'turn/start':
        lastTurnStart = event.seq;
        break;
      case 'turn/end':
        lastTurnEnd = event.seq;
        lastTurnEndReason = event.data?.reason?.kind ?? null;
        lastTurnEndError = event.data?.reason?.error ?? event.data?.reason?.failure ?? null;
        lastTurnEndCause = event.data?.reason?.reason?.kind ?? null;
        // 2026-09-08：注入后失败 streak 统计——仅网络瞬时类摸板；注入后无产出再网络失败 → streak++，
        // 注入后曾有产出（模型工作过）→ 重新武装 streak 归零（恢复满次数）。
        if (lastOursSeq > -1 && lastTurnEnd > lastOursSeq && lastTurnEndReason === 'error' && isNetworkFailure(lastTurnEndError)) {
          if (assistantAfterOurs || toolAfterOurs) failStreak = 0;
          else failStreak += 1;
        }
        // 2026-09-20：重启循环守卫结算（与上方 failStreak 互不干扰，故另用 pendingOursSeq
        // 做归因指针——不复用 lastOursSeq，避免破坏网络分支 continuedThenFell 的既有语义）。
        if (pendingOursSeq > -1 && lastTurnEnd > pendingOursSeq) {
          // 这条 turn/end 归属于我们的注入：
          //   completed                       → 环境交付了完成的轮次 → 清除置位（re-arm）；
          //   interrupted + 零产出             → 被环境杀死 → 置位；
          //   interrupted + 有产出 / 网络 error → 健康工作被打断，**既不置位也不清除**——
          //     已有置位仍成立（零产出被杀之后没出现任何 completed，重启循环判据未解除）。
          if (lastTurnEndReason === 'completed') {
            hasKilledNoProgress = false; killedNoProgressSeq = -1; killedNoProgressTime = -1;
          } else if (lastTurnEndReason === 'interrupted' && !(assistantAfterOurs || toolAfterOurs)) {
            hasKilledNoProgress = true;
            killedNoProgressSeq = lastTurnEnd;
            if (Number.isFinite(event.time)) killedNoProgressTime = event.time;
          }
          pendingOursSeq = -1;
        } else if (hasKilledNoProgress) {
          // 非我们驱动的轮次结束（用户自己打的「继续」等）：
          //   completed → 环境交付了完成的轮次，最强 re-arm 信号（§一百三十五原规则，保留）；
          //   其他结束原因 + 置位后出现真实产出 + 距置位 ≥ restartLoopDecayMs → 时限重武装。
          // 第二条修的是「只有 completed 才解除」造成的永久死锁：被反复打断的会话永远产生
          // 不了 completed，守卫因此自我锁死（本会话 20:43:07 置位 → 20:46:53 循环已停 →
          // 20:55:08 与 21:06:25 两次真实中断仍被拦，见函数头注释）。
          if (lastTurnEndReason === 'completed') {
            hasKilledNoProgress = false; killedNoProgressSeq = -1; killedNoProgressTime = -1;
          } else if (killedNoProgressSeq > -1 && lastProgressSeq > killedNoProgressSeq
              && killedNoProgressTime > -1 && Number.isFinite(event.time)
              && (event.time - killedNoProgressTime) >= restartLoopDecayMs) {
            hasKilledNoProgress = false; killedNoProgressSeq = -1; killedNoProgressTime = -1;
          }
        }
        break;
      case 'step/start':
        lastStepStart = event.seq;
        break;
      case 'step/end':
        lastStepEnd = event.seq;
        break;
      case 'assistant/chunk':
      case 'assistant/message':
        // 2026-08-31：assistant/chunk 计入「注入后进展」——流式推理块是模型已开始
        // 产出的强证据（双注入守卫据此区分「注入后被环境杀死」与「注入后真实工作被打断」）。
        // 2026-09-01 修正：仅**真实产出块**（text/reasoning/tool-call delta 与 block-*）
        // 计入；usage/finish 是计费/结束元数据，请求被拒（如 402 无余额）也会写——
        // 计入会让 loop-guard 失效造成无限注入（实证 401860fc 循环根因）。
        lastAssistant = event.seq;
        if (event.type === 'assistant/message' || isProgressChunk(event)) {
          if (lastOursSeq > -1) assistantAfterOurs = true;
          lastProgressSeq = event.seq;   // 2026-09-20：重启循环守卫的时限重武装基准
        }
        break;
      case 'user/message':
        lastUser = event.seq;
        lastUserIsOurs = isOurContinueMessage(event, continueText);
        if (lastUserIsOurs) {
          lastOursSeq = event.seq;
          assistantAfterOurs = false;
          toolAfterOurs = false;
          pendingOursSeq = event.seq;   // 2026-09-20：重启循环守卫的归因指针
        }
        break;
      case 'agent/inbox/spliced':
        applyInboxSplice(pendingInbox, event.data);
        break;
      case 'tool/call': {
        const callId = event.data?.callId;
        if (callId !== undefined) pendingCalls.add(callId);
        if (lastOursSeq > -1) toolAfterOurs = true;
        lastProgressSeq = event.seq;   // 2026-09-20：工具调用＝模型在真实工作
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

  // 2026-09-21（缺陷 B：用户手动停止不得触发自动继续）：悬挂边界只有在**轮次仍打开**时才是
  // 「这轮没干完」的证据。turn/end 一旦写出，该轮次已终结（completed / aborted / error…），
  // 残留的 open step 与无结果的 tool/call 只是驱动收尾时的痕迹——若仍计入可继续判据，
  // 用户按一次停止键就会被下次轮询判 interrupted 并注入「继续」，等于推翻用户指令。
  // 闭合轮次一律落到下方按 turn/end 原因的判定（error 走网络分支，其余 settled）。
  const reasons = [];
  if (openTurn) reasons.push('open turn');
  if (openStep && openTurn) reasons.push('open step');
  if (pendingTool && openTurn) reasons.push(`${pendingCalls.size} pending tool call(s)`);

  // 2026-09-13 队列守卫：折叠 inbox 挂起项，别人的消息在等 → 一律不碰（见文件头 ①）。
  const pendingList = [...pendingInbox['next-turn'], ...pendingInbox['next-step']];
  const pendingOwn = pendingList.filter(message => isOurMessage(message, continueText)).length;
  const pendingInput = {
    nextTurn: pendingInbox['next-turn'].length,
    nextStep: pendingInbox['next-step'].length,
    own: pendingOwn,
    others: pendingList.length - pendingOwn
  };

  // 2026-08-31 双注入守卫（重启/进程死亡循环守卫）：
  // 我们上次注入「继续」后未产生任何 assistant 内容/工具调用便再次进入 interrupted ——
  // 说明注入被环境杀死（进程死亡/重启循环），而非真实业务中断 → 转 settled 不注入。
  // 实证：16:48:28 boot#34 注入#1 → 16:48:30 systemd 重启杀死 turn 4（零产出）→
  // 16:48:40 boot#35 重扫误判 interrupted 再注入#2。本守卫使 boot#35 判 settled。
  // 与网络分支 continuedThenFell（~215 行）同构，但覆盖 interrupted（含 open turn/step）。
  // 注入后 turn 尚未闭合即被进程杀死（无 turn/end 可结算）：同属「被环境杀死零产出」，
  // 否则下次 boot 会重复注入（= 用例 D5）。
  const openTurnOursNoProgress =
    openTurn && pendingOursSeq > -1 && lastTurnStart > pendingOursSeq
    && !assistantAfterOurs && !toolAfterOurs;
  const injectionKilledWithoutProgress = hasKilledNoProgress || openTurnOursNoProgress;

  // 2026-09-13 队列守卫（优先于 interrupted/network 判定）：inbox 里有**别人的**挂起消息时，
  // 会话本就等着被这批输入驱动；我们再 send(wakeup) 会把它们冲进会话，而我们自己的「继续」
  // 排在后面变成排队不执行。故此状态不 resume、不注入，交由用户/客户端自己走。
  // 重启循环守卫的「已武装时长」——只用于 settled 理由的可观测性，不参与判定。
  const lastEventTime = Number.isFinite(list[list.length - 1]?.time) ? list[list.length - 1].time : -1;
  const guardAgeNote = hasKilledNoProgress && killedNoProgressTime > -1 && lastEventTime > -1
    ? `; armed ${Math.round((lastEventTime - killedNoProgressTime) / 1000)}s ago, re-arms after ${restartLoopDecayMs}ms of post-arm progress`
    : '';
  if (skipWhenInputPending && pendingInput.others > 0) {
    return {
      state: 'pending-input',
      reason: `queued input pending (next-turn=${pendingInput.nextTurn}, next-step=${pendingInput.nextStep}, others=${pendingInput.others}) — not touching`,
      pendingInput
    };
  }
  // 我们上一条「继续未完成的任务」还挂在 inbox 里（尚未被 driver 认领，因此没有对应的
  // user/message 事件）——不再补发，避免同一会话堆积多条「继续」。
  if (pendingInput.own > 0) {
    return { state: 'completed', reason: 'previous autoresume prompt still pending (inbox)', pendingInput };
  }
  // 2026-09-21（缺陷 A）：含 tool-call 块的 assistant/message 是**工具请求**，不是终结回复——
  // 不落 completed，让下面的 open turn 判定接手（宿主已补 ToolNotStartedError 并要求重试）。
  if (lastType === "assistant/message" && !messageHasToolCall(lastEvent?.data?.message)) {
    return { state: 'completed', reason: 'last event is assistant/message' };
  }
  if (reasons.length > 0) {
    if (injectionKilledWithoutProgress) {
      return { state: 'settled', reason: `autoresume inject interrupted before any progress (restart loop guard)${guardAgeNote}` };
    }
    return { state: 'interrupted', reason: reasons.join(' + ') };
  }
  if (lastTurnEndReason === 'interrupted') {
    if (injectionKilledWithoutProgress) {
      return { state: 'settled', reason: `autoresume inject interrupted before any progress (restart loop guard)${guardAgeNote}` };
    }
    return { state: 'interrupted', reason: 'last turn/end reason = interrupted' };
  }
  // 2026-09-21（缺陷 B，用户明示「绝对的 bug」）：**用户手动停止是终态，绝不自动继续**。
  // aborted 由驱动主动收尾（cancel 的 finally 写出 turn/end、边界闭合、无 turn/end 缺口），
  // 与「环境杀死进程」的 interrupted（turn/end 缺失、open turn）有本质区别——
  // aborted/user＝用户按停止键（keepInbox 保留其待办输入，自己接着走），
  // aborted/disposed＝生命周期拆除。两者都不得注入「继续」推翻用户指令。
  // 位置在 reasons 判定**之后**：若上一个 aborted 轮次之后又起了新轮次且被环境杀死
  // （open turn），那属于真实中断，仍应继续。
  if (lastTurnEndReason === "aborted") {
    return { state: 'settled', reason: `turn ended by explicit abort (${lastTurnEndCause ?? 'unknown'}), user stop is final` };
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
    // 含账户余额类（QUOTA/402/Insufficient balance，2026-08-29 加入）与
    // OpenRouter 上游 provider 故障（"Provider returned error"，2026-08-31 加入，实证可恢复）：
    // 重试可恢复，注入「继续」让其自动重跑（2026-08-24 新增能力）。
    // 死循环守卫（2026-08-24）：若我们上次注入「继续」之后未产生任何内容/工具调用便再次
    // 以同类网络错误失败（模型持续空返回），判定为持续故障 → 转 settled 不注入，交由用户。
    // 2026-09-01 强化（402 无限循环实证修复）：余额类错误（402/QUOTA/Insufficient balance）
    // 是**持久性**故障——注入后即使有产出（如先吐 text 再 402），下次调用仍必失败；
    // 注入「继续」后再次以余额类错误失败即转 settled，无论有无产出（首次 402 仍注入一次，
    // 覆盖「充值后恢复」场景；充值/换 provider 后由用户手动继续或下次自然成功）。
    const balanceFailed = isBalanceFailure(lastTurnEndError);
    // 2026-09-08：死循环守卫放宽（商汤日日新裁决）——允许**连续两次**自动继续：
    // 网络瞬时类在注入后无产出失败时，failStreak 达 maxResumeAttempts（默认 2）才转 settled；
    // 余额类（持久性，§五十四）保持「注入后再次失败无论有无产出一次即停」，防真没余额无限循环。
    const continuedThenFell = lastOursSeq > -1 && lastTurnEnd > lastOursSeq && (balanceFailed || failStreak >= maxResumeAttempts);
    if (continuedThenFell) {
      return { state: 'settled', reason: `autoresume continue led to ${balanceFailed ? 'persistent balance failure' : `network failure without progress (${failStreak}/${maxResumeAttempts} attempts)`} (loop guard): ${describeFailure(lastTurnEndError)}` };
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

/**
 * 2026-09-13（0.1.5-rc.2 适配）：会话日志的物理代际。DSH 的 SESSION_FORMAT_VERSION 在
 * 0.1.5-rc.2 为 3，当前代际文件名为 session.v3.jsonl.zstd；初代（版本 0）沿用
 * session.jsonl.zstd 作为历史代际文件。同一会话目录内取**最高代际**为当前日志。
 * 旧版本只认 session.jsonl.zstd → 0.1.5 下几乎所有活跃会话（v3）都扫不到。
 */
const SESSION_LOG_GENERATIONS = [
  { name: 'session.v3.jsonl.zstd', version: 3 },
  { name: 'session.v3.jsonl', version: 3 },
  { name: 'session.jsonl.zstd', version: 0 },
  { name: 'session.jsonl', version: 0 }
];

/** 纯函数：从会话目录的文件名列表里选出当前代际日志名（导出供测试）。 */
export function pickSessionLog(filenames) {
  const list = Array.isArray(filenames) ? filenames : [];
  let best;
  for (const candidate of SESSION_LOG_GENERATIONS) {
    if (!list.includes(candidate.name)) continue;
    if (best === undefined || candidate.version > best.version) best = candidate;
  }
  return best?.name;
}

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
        const dir = join(sessRoot, s.name);
        let entries;
        try { entries = readdirSync(dir); } catch { continue; }
        const logName = pickSessionLog(entries);
        if (logName === undefined) continue;
        const file = join(dir, logName);
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
  // 2026-09-08（商汤日日新裁决）：允许连续两次自动继续——网络瞬时类在注入后无产出失败时
  // 最多重试 maxResumeAttempts 次（默认 2）才转 settled；余额类不受影响（一次即停）。
  const maxResumeAttempts = positiveInt(config.maxResumeAttempts, 2);
  // 2026-09-13：队列守卫（默认开）。关掉＝回到旧行为——会把 inbox 里挂起的用户消息
  // 一并 wake 进会话，且我们这个「继续未完成的任务」排到那批消息之后（用户实报的 bug）。
  const skipWhenInputPending = config.skipWhenInputPending !== false;

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
  function installSessionSelection(agent, agentCtx) {
    // 2026-09-13（0.1.5 适配，**关键**）：AgentSetup 的回调签名已变为 (agentCtx, agent)
    // （dsh-agent 类型：export type AgentSetup = (agentCtx: Context, agent: Agent) => …）。
    // 旧代码只收 agentCtx 并读 agentCtx.agent —— 0.1.5 上取不到 agent → 下一行
    // installModelSelection(undefined.ctx) 抛错 → agents.resume() 整体 reject →
    // 会话虽被"部分"挂起（journal 只有 early inspect/session-start），
    // **「继续未完成的任务」永远不会注入**（2026-09-13 实机取证：无 self-resumed / injected）。
    const target = agent ?? agentCtx?.agent;
    if (target === undefined) {
      throw new Error('dsh-autoresume: installSessionSelection 未拿到 agent（0.1.5 的 setup 签名为 (agentCtx, agent)）');
    }
    let picked;
    let selScanLen = 0;
    let selCached;
    const selection = {
      get current() {
        if (picked !== undefined) return picked;
        // 2026-09-17 modelroute 修复：优先采用会话持久化的待生效模型选择
        // （model/selection 事件），再退回最后一次请求头——与宿主 selectionFor
        // 的「pending → lastUsed」优先级对齐。此前 autoresume 恢复的会话会把
        // 用户切换后的模型钉回旧通道（如已欠费 huoshan2 → 429 AccountQuotaExceeded）。
        try {
          const log = target?.session?.log;
          if (Array.isArray(log)) {
            for (let i = selScanLen; i < log.length; i++) {
              const event = log[i];
              if (event?.type === 'model/selection' && event.data?.provider && event.data?.model) {
                selCached = {
                  provider: event.data.provider,
                  model: event.data.model,
                  ...(event.data.reasoningEffort === undefined ? {} : { reasoningEffort: event.data.reasoningEffort })
                };
              }
            }
            selScanLen = log.length;
          }
        } catch {
          /* 扫描失败不影响后续回退 */
        }
        if (selCached !== undefined) return selCached;
        let logged;
        try {
          logged = target?.session?.requestHeader?.()?.config;
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
    installModelSelection(target.ctx, selection);
  }

  /**
   * 2026-09-13（0.1.5-rc.2 适配，**关键修复**）：读取一条会话的完整事件流。
   *
   * 0.1.5 的 SessionPersistence **移除了 inspect()**——公开面只有
   * create / open(id, access) / flush / stat / list（见 dsh-session-persistence 类型声明）。
   * 旧代码 4 处调用 ctx.sessionPersistence.inspect() 在 0.1.5 上**每次都抛**
   * （inspect is not a function），且 catch 只走 ctx.logger.warn（不进 journal）→
   * **重启后自动继续完全静默失效**（用户实报「自动继续没有在这里生效」）。
   *
   * 现值：open(id,'read') → handle.read() → close()，返回形状保持 { meta, events }，
   * 与既有调用点（sessionPresetId / analyzeSessionEvents）兼容。
   * 会话不存在返回 undefined，由调用方按「不动作」处理（不注入、不 resume）。
   */
  async function inspectSession(sessionId) {
    const handle = await ctx.sessionPersistence.open(sessionId, 'read');
    try {
      const result = await handle.read();
      return { meta: handle.header, events: result?.events ?? [] };
    } finally {
      try { await handle.close(); } catch { /* 关闭失败不影响已读到的结果 */ }
    }
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
        const inspection = await inspectSession(sessionId);
        const presetId = sessionPresetId(inspection);
        if (presetId !== undefined) {
          const resolved = await presets.resolve(presetId);
          setup = async (agentCtx, agent) => {
            installSessionSelection(agent, agentCtx);
            await presets.mount(agentCtx, resolved.id);
          };
        } else {
          setup = async (agentCtx, agent) => { installSessionSelection(agent, agentCtx); };
        }
      } else {
        setup = async (agentCtx, agent) => { installSessionSelection(agent, agentCtx); };
      }
    } catch (error) {
      setup = undefined;
      ctx.logger.warn(`dsh-autoresume: preset compose for ${sessionId} failed, plain resume fallback: ${String(error?.message ?? error)}`);
    }
    // 2026-08-31：resume 必须带 agentOptions（部署默认模型）——恢复后的 agent.options
    // 若缺 model，sidechat.start 子代理继承 {...parent.options} 会得到空 options，
    // 首轮装配即报 prompt variable "{{model}}" has no value。
    let defaultAgentOptions;
    try {
      const defaultModel = ctx.get('agentDefaultModel');
      const selected = defaultModel && typeof defaultModel.currentSelection === 'function' ? defaultModel.currentSelection() : undefined;
      if (selected && typeof selected.provider === 'string' && selected.provider !== '' && typeof selected.model === 'string' && selected.model !== '') {
        defaultAgentOptions = { provider: selected.provider, model: selected.model };
      }
    } catch { /* agentDefaultModel 缺失：保持无 options（组装仍靠 installSessionSelection 兜底） */ }
    await ctx.agents.resume({
      resumeSessionId: sessionId,
      ...(defaultAgentOptions === undefined ? {} : { agentOptions: defaultAgentOptions }),
      ...(setup === undefined ? {} : { setup })
    });
  }

  // per-session 早期路径串行化（防并发抢先 resume 竞态，2026-08-22 教训）
  const earlyPromises = new Map();
  const childInFlight = new Set();

  // 子代理必须由宿主控制面恢复，普通 agents.resume 不建立 Activation/父级通知。
  async function recoverChild(sessionId, inspection, analysis, agent) {
    const meta = inspection?.meta;
    if (meta?.origin !== 'subagent') return false;
    if (!isResumableState(analysis.state)) { pendingResume.delete(sessionId); return true; }
    // 活体 open turn 是启动/执行中间态，不是进程死亡证据。
    if (analysis.state === 'interrupted' && analysis.reason.includes('open turn') && (agent || meta.createdAt >= bootStartedAtMs)) {
      pendingResume.add(sessionId);
      return true;
    }
    pendingResume.add(sessionId);
    if (childInFlight.has(sessionId)) return true;
    const parent = typeof meta.parentSession === 'string' ? getAgent(meta.parentSession) : undefined;
    if (!parent || parent.status === 'disposed') return true;
    if (agent) {
      const pending = livePendingInput(agent);
      if (agent.status !== 'idle' || pending.unavailable || pending.total > 0) return true;
    }
    childInFlight.add(sessionId);
    try {
      const runtime = ctx.get('subagents');
      if (!runtime) throw new Error('subagent control plane unavailable');
      const msg = buildContinueMessage(promptText);
      const id = await queueHostSubagentPrompt(runtime, parent, sessionId, msg.content, msg.source, new AbortController().signal);
      pendingResume.delete(sessionId);
      console.error(`[dsh-autoresume] managed-child accepted ${sessionId} message=${id}`);
    } catch (error) {
      ctx.logger.warn(`dsh-autoresume: managed child ${sessionId} deferred: ${String(error?.message ?? error)}`);
    } finally { childInFlight.delete(sessionId); }
    return true;
  }

  function runEarlyPath(sessionId) {
    if (earlyPromises.has(sessionId)) return earlyPromises.get(sessionId);
    const p = (async () => {
      let analysis;
      try {
        const inspection = await inspectSession(sessionId);
        if (inspection === undefined) {
          console.error(`[dsh-autoresume] early inspect ${sessionId} skipped: session not found`);
          return;
        }
        analysis = analyzeSessionEvents(inspection.events, promptText, maxResumeAttempts, { skipWhenInputPending });
        if (await recoverChild(sessionId, inspection, analysis, undefined)) return;
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
    return p.catch(() => {}).finally(() => { earlyPromises.delete(sessionId); });
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

  /**
   * 2026-09-01：ctx.agents 惰性注入服务的防御访问。DSH cordis 框架在插件上下文未
   * 活性/服务未注入就绪时用 Proxy 拦截对未注入服务的访问（抛 "cannot get required
   * service \"agents\" in inactive context"），此时直接访问会导致插件树 fatal 崩溃
   * 循环（实证 20:04-20:23 dsh-web 13 次崩溃）。先 try/catch 捕获，未就绪返回
   * undefined 让调用方降级跳过（本轮不动作、下轮 poll 重试），不中断插件树加载。
   */
  /**
   * 2026-09-13：活体 inbox 挂起项读取（注入前的主路径判据）。inbox 是 dsh-agent 运行面
   * 正式接口（runtime-types: readonly nextTurn / readonly nextStep）。读不到＝宿主未提供
   * 该接口——宁可不注入也不猜（红线 9：主路径不可行就停下，不找替代路径兜底）。
   */
  function livePendingInput(agent) {
    try {
      const inbox = agent?.inbox;
      const nextTurn = Array.isArray(inbox?.nextTurn) ? inbox.nextTurn.length : undefined;
      const nextStep = Array.isArray(inbox?.nextStep) ? inbox.nextStep.length : undefined;
      if (nextTurn === undefined || nextStep === undefined) {
        return { unavailable: true, nextTurn: 0, nextStep: 0, total: 0 };
      }
      return { unavailable: false, nextTurn, nextStep, total: nextTurn + nextStep };
    } catch (error) {
      return { unavailable: true, nextTurn: 0, nextStep: 0, total: 0, error: String(error?.message ?? error) };
    }
  }

  function getAgent(sessionId) {
    try {
      return ctx.agents.get(sessionId);
    } catch (error) {
      ctx.logger.warn(`dsh-autoresume: ctx.agents not ready (inactive context) for ${sessionId} — skip, retry next poll: ${String(error?.message ?? error)}`);
      return undefined;
    }
  }

  let checking = false;
  async function checkOnce(source) {
    if (checking) return;
    checking = true;
    try { await checkCandidates(source); }
    catch (error) { ctx.logger.warn(`dsh-autoresume: check failed: ${String(error?.message ?? error)}`); }
    finally { checking = false; }
  }

  async function checkCandidates(source) {
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
      // 2026-09-01 崩溃修复：ctx.agents 是惰性注入服务，在插件上下文未活性/服务注入
      // 就绪前访问会抛 "cannot get required service \"agents\" in inactive context"
      // （实证：boot 后 3s setTimeout 首轮 checkOnce 触发时上下文可能未活性 → fatal 崩溃循环）。
      // 用防御助手访问：捕获后 warn 降级、本轮跳过该会话，下轮 poll 5s 后重试，不中断插件树加载。
      const agent = getAgent(sessionId);
      if (agent === undefined) {
        // agent 未 live / 服务未就绪（inactive context）：直读持久化流判定，
        // 被打断则自行 resume（持续在 pendingResume 待注入）；服务就绪前跳过本轮。
        await runEarlyPath(sessionId);
        continue;
      }
      if (agent.status !== 'idle') { pendingResume.add(sessionId); console.error(`[dsh-autoresume] poll wait: ${sessionId} status=${agent.status}`); continue; }
      let inspection;
      try {
        inspection = await inspectSession(sessionId);
      } catch (error) {
        ctx.logger.warn(`dsh-autoresume: inspect(${sessionId}) failed: ${String(error?.message ?? error)}`);
        continue;
      }
      if (inspection === undefined) continue;
      const analysis = analyzeSessionEvents(inspection.events, promptText, maxResumeAttempts, { skipWhenInputPending });
      console.error(`[dsh-autoresume] ${sessionId} state=${analysis.state} reason=${analysis.reason} source=${source}`);
      if (await recoverChild(sessionId, inspection, analysis, agent)) continue;
      if (!isResumableState(analysis.state)) { pendingResume.delete(sessionId); continue; }
      // 2026-09-13 队列守卫（活体判据）：inbox 有挂起输入 → 不 wake、不注入。
      if (skipWhenInputPending) {
        const pending = livePendingInput(agent);
        if (pending.unavailable) {
          console.error(`[dsh-autoresume] inject skip: ${sessionId} agent.inbox 不可读（宿主未提供该接口）— 保守不注入`);
          ctx.logger.warn(`dsh-autoresume: agent.inbox unavailable for ${sessionId} — skip injection (no guessing)`);
          continue;
        }
        if (pending.total > 0) {
          console.error(`[dsh-autoresume] inject skip: ${sessionId} inbox 有 ${pending.total} 条挂起输入（next-turn=${pending.nextTurn}, next-step=${pending.nextStep}）— 不触碰`);
          pendingResume.delete(sessionId);
          continue;
        }
      }
      try {
        const msg = buildContinueMessage(promptText);
        agent.send(msg, 'next-turn', true);
        injected = true;
        pendingResume.delete(sessionId);
        console.error(`[dsh-autoresume] injected「${promptText}」inject#${msg.id} session=${sessionId} source=${source}`);
        ctx.logger.info(`dsh-autoresume: injected「${promptText}」inject#${msg.id} into ${sessionId}`);
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
    // 2026-09-01 崩溃修复：同 checkOnce，ctx.agents 未活性时防御性跳过（不再抛 inactive context）。
    const agent = getAgent(sessionId);
    if (agent === undefined) { console.error(`[dsh-autoresume] inject wait: ${sessionId} agent not live / service not ready`); return; }
    if (agent.status !== 'idle') { console.error(`[dsh-autoresume] inject wait: ${sessionId} agent status=${agent.status}`); return; }
    let inspection;
    try { inspection = await inspectSession(sessionId); }
    catch (error) { ctx.logger.warn(`dsh-autoresume: inject inspect(${sessionId}) failed: ${String(error?.message ?? error)}`); return; }
    if (inspection === undefined) return;
    const analysis = analyzeSessionEvents(inspection.events, promptText, maxResumeAttempts, { skipWhenInputPending });
    if (await recoverChild(sessionId, inspection, analysis, agent)) return;
    console.error(`[dsh-autoresume] inject check ${sessionId} state=${analysis.state}`);
    if (!isResumableState(analysis.state)) { pendingResume.delete(sessionId); console.error(`[dsh-autoresume] inject skip: ${sessionId} state=${analysis.state}`); return; }
    if (skipWhenInputPending) {
      const pending = livePendingInput(agent);
      if (pending.unavailable) {
        console.error(`[dsh-autoresume] inject skip: ${sessionId} agent.inbox 不可读（宿主未提供该接口）— 保守不注入`);
        ctx.logger.warn(`dsh-autoresume: agent.inbox unavailable for ${sessionId} — skip injection (no guessing)`);
        return;
      }
      if (pending.total > 0) {
        console.error(`[dsh-autoresume] inject skip: ${sessionId} inbox 有 ${pending.total} 条挂起输入（next-turn=${pending.nextTurn}, next-step=${pending.nextStep}）— 不触碰`);
        pendingResume.delete(sessionId);
        return;
      }
    }
    try {
      const msg = buildContinueMessage(promptText);
      agent.send(msg, 'next-turn', true);
      injected = true;
      pendingResume.delete(sessionId);
      console.error(`[dsh-autoresume] injected「${promptText}」inject#${msg.id} session=${sessionId}`);
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
