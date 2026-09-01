# Changelog

本文件记录 dsh-autoresume 的发布版本变更。版本号与 package.json 同步。

## 0.0.16 — 2026-09-01

- **启动崩溃循环修复（ctx.agents inactive-context 防御）**：DSH 0.1.2-alpha.3 升级后，插件在插件树加载阶段因 `ctx.agents.get()` 在**插件上下文未活性/服务注入未就绪**时访问触发 cordis `inactive context` 守卫拦截而抛 `fatal load failure: Error: cannot get required service "agents" in inactive context`（journal 实证崩溃循环 restart 达 13 次，`checkOnce` 处 `setTimeout` 3s 首轮触发时上下文可能未活性）。**修复**：新增防御助手 `getAgent(sessionId)`（`try/catch` 捕获 inactive-context 异常 → `ctx.logger.warn` → 返回 `undefined`，参考 prompt-polish `ctx 服务访问 try/catch 降级` 范式）；`checkOnce()` 与 `injectIfIdle()` 两处 `ctx.agents.get()` 改用该助手——未就绪时 warn 降级、本轮跳过该会话，下轮 5s poll 重试，不中断插件树加载。核对其余访问点已受保护（`ctx.sessionPersistence.inspect` 已各自 try/catch、`resumeSession` 内 inspect/resume 有外层 try/catch），无需再补。
- 验证：① node --check（src/lib）+ build src→lib 一致（md5 `3c1733df...`）+ import 冒烟 5 exports + inject 声明在位；② 分类回归 3/3（completed / network-stopped(RATE_LIMIT) / interrupted 行为不变）；③ dsh-web 由 DSH 重启通过——journal 无 `cannot get required service "agents"` / `inactive context` / `status=1`，`[dsh-autoresume]` 正常日志出现，重启后跨 60s 稳定 3080=401/200。**未自行重启（遵循重启纪律，由 DSH server-ops 执行并验证）**。

## 0.0.15 — 2026-09-01

- **402/余额类无限循环修复**（用户直报：真没余额后自动继续无限循环——`PI_AI_ERROR`/`上下文注入`/`dsh-autoresume`/`继续（自动）`/`本轮运行失败 402 status code (no body)` 反复出现）。双根因：
  - ① `assistant/chunk` 的 `usage`/`finish` 是 LLM 调用计费/结束**元数据**（请求被拒也会写），此前一律计入「注入后进展」→ `continuedThenFell` 的 `!assistantAfterOurs` 永不满足 → loop-guard 失效 → 每次注入后 402 都判 `network-stopped` 再注入。**修复**：仅真实产出块（`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-start`/`block-end`）计入 `assistantAfterOurs`。
  - ② 余额类错误（`402 status code (no body)`/`QUOTA`/`Insufficient balance`/`insufficient_balance`/`payment_required`）是**持久性**故障——充值或换 provider 前每次 LLM 调用必失败，与瞬时网络故障（429/5xx）性质不同。**修复**：新增 `BALANCE_LLM_CODES`/`BALANCE_FAILURE_PATTERN`/`isBalanceFailure()`；注入「继续」后再次以余额类错误失败 → 无论有无产出**一律转 `settled`** 不再注入（首次 402 仍注入一次，覆盖「充值后恢复」场景；充值/换 provider 后用户手动继续即可）。
- **400 与中文瞬时特征（同轮追加）**：① `NETWORK_FAILURE_PATTERN` 补 `\b400\b`（tokenrhythm/pi-ai 适配器兜底形态 `400 status code (no body)`，用户裁定与 402 同为可继续错误）与中文瞬时特征（`模型服务暂时不可用`/`服务暂时不可用`/`请稍后重试`/`稍后再试`/`当前繁忙`/`服务器繁忙`——用户实报 tokenrhythm 返回 `模型服务暂时不可用，请稍后重试` 0 tok 即时失败，语义等同 `service temporarily unavailable`，此前落入 settled 不注入）；② 新增 `PERMANENT_LLM_CODES` 先于特征匹配排除永久码（`UNKNOWN_MODEL`/`MISSING_CREDENTIAL`/`NO_ADAPTER`/`INVALID_MODEL_INFO`/`CONTEXT_WINDOW_EXCEEDED`/`MODEL_NOT_FOUND`）——保 CHANGELOG 0.0.12 回归基线：`CONTEXT_WINDOW_EXCEEDED`（上下文超限，重试必失败）即使携带 `400 status code (no body)` 也判 settled 不注入。循环由 loop-guard 兜底。
- 验证：① node --check + build(src→lib 一致) + import 冒烟 5 exports；② 真实 401860fc 事件流复跑——逐 turn/end 判定：首次 402→`network-stopped`（注入一次），注入后再 402→`settled`(persistent balance failure loop guard) **循环切断**；③ 回归矩阵 19/19 PASS（瞬时 429/5xx/upstream 有产出仍可再注入不误伤、首次 402 仍注入、completed/aborted/interrupted/UNKNOWN_MODEL/empty 不受影响）；④ 重启（PID 2189009→2207586，Result=success NRestarts=0）3 连测 200×3；⑤ 实机 401860fc 注入后**成功恢复**（turn 13 正常产出，无再 402），系统无 `persistent balance failure` 残留。400/中文瞬时矩阵 16/16 PASS（真实 10e7bd97 复跑：`400 status code (no body)`/`模型服务暂时不可用，请稍后重试` → network-stopped，CONTEXT_WINDOW_EXCEEDED 回归 settled）；二次重启（PID 2207586→2216423→2217741，Result=success NRestarts=0）3 连测 200×3，boot 扫描正常注入无异常。

## 0.0.14 — 2026-09-01

- **双注入守卫（重启/进程死亡循环守卫）**：网络分支 `continuedThenFell` 的同构守卫推广到 `interrupted` 分支——若「上次注入 → 模型零产出（assistant/chunk 与 assistant/message 都未出现，无工具调用）→ 再次被打断」，判定为**环境噪音**（dsh-web 崩溃循环 / 进程被 systemd 重启杀死 turn）而非真实业务中断，转 `settled` 不再注入，把决定权交还用户。守卫基于**持久化会话事件流**（不依赖进程内存态），跨进程/跨重启一致生效。
- **`assistant/chunk` 计入「注入后进展」**：流式推理块是模型已开始产出的强证据——守卫据此区分「注入后被环境杀死（零 chunk/message）」与「注入后真实工作被打断（已有 chunk/message）」，真实中断仍正常续跑，不误伤。
- **注入日志带 `inject#<id>`**：每条「继续」消息唯一 id（`randomUUID`），跨进程审计可精确定位「同一进程第几次注入」「不同进程各注入一次」（双注入事故根因分析用）。
- **`agentOptions` 自动注入**（resume 修复）：从 `agentDefaultModel.currentSelection()` 取部署默认模型透传到 `ctx.agents.resume({ agentOptions })`——修复子代理（sidechat.start）首轮装配报 `prompt variable "{{model}}" has no value` 的隐性 race。
- 验证：场景矩阵 **13/13 PASS**（双注入守卫两路：reasons.length 分支 + lastTurnEndReason='interrupted' 分支；assistant/chunk 计入；agentOptions 透传；回归 loop-guard / UNKNOWN_MODEL / network-stopped / 真实中断四路）。

## 0.0.13 — 2026-08-31

- **OpenRouter 上游 provider 故障识别**：`NETWORK_FAILURE_PATTERN` 补 `provider returned error` 特征——OpenRouter 对上游 provider（如 minimax）故障的标准文案（pi-ai adapter 兜底归类 `PI_AI_ERROR`，属瞬时上游故障、同 provider 稍后可恢复）同样判 network-stopped 注入「继续（自动）」。实证：真实会话 78s 无产出以 `PI_AI_ERROR: Provider returned error` 收尾（旧版判 settled 不注入），同 provider 稍后手动「继续」即成功——确属瞬时上游故障，应注入。
- 验证：场景矩阵 **14/14 PASS**（真实失败会话 → network-stopped 注入 + self-resumed；loop-guard/UNKNOWN_MODEL/completed/TRANSPORT/504 嵌套信封/open turn 回归全绿）。

## 0.0.12 — 2026-08-31

- **504 Gateway Time-out（ALB 网关超时）识别强化**：`unwrapError` 由单层信封改为**递归剥到最内层**（支持任意深度 `{error:{...}}` 嵌套，并优先取 `failure` 负载字段）——外部用户环境的多层错误信封（如 `{error:{error:{code,message}}}`）此前会判 settled 不注入，现已正确判 network-stopped 注入「继续（自动）」；`NETWORK_FAILURE_PATTERN` 补 `gateway time-?out` 特征（覆盖 504 HTML 被截断丢失状态码数字、只剩 "Gateway Time-out" 标题的场景）。
- 验证：场景矩阵 **18/18 PASS**（504+SERVER/裸 HTML/一层/两层/三层信封、reason.failure、数字 code、转义 HTML、仅 gateway 标题、UNKNOWN_MODEL/CONTEXT_WINDOW_EXCEEDED 回归均正确）。

## 0.0.11 — 2026-08-29

- **支持 402（Insufficient balance / QUOTA）自动继续**：账户余额类错误（code `QUOTA`/`insufficient_balance`/`payment_required`，或消息含 `402`/`insufficient balance`/`payment required`/`quota exceeded`/`quota exhausted`）现在也会触发「继续（自动）」注入——充值或切换 provider 后会话可自动恢复；loop-guard 死循环守卫保持（注入后无产出再失败 → settled 不注入）。
- **隐私脱敏**：默认目标会话 ID 改为占位符（发布版不携带真实会话 UUID）；会话根目录回退用 `homedir()`（不写死路径）。

## 0.0.10 — 2026-08-27

- **自动继续永久不睡**：`bootGraceMs` 默认值 30min → Infinity，覆盖 14h+ 前因网络错误停止的历史会话（此前进程超窗后永久 disarmed）。

## 0.0.9 — 2026-08-24

- **运行期间再次网络失败也自动继续**：`liveWatch`（默认 true）boot 后保持轮询（仅 mtime 变化会话），补 catch 运行期间的再次网络/瞬时失败；**loop-guard 死循环守卫**——注入「继续」后无产出便再以同类网络错误失败 → 转 settled 不注入（防模型持续空返回死循环）。

## 0.0.8 — 2026-08-24

- **支持网络错误停止自动继续**：网络/瞬时故障（`EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`，或消息命中网络特征）导致会话停止时也注入「继续」；配置/模型类错误（`UNKNOWN_MODEL`/`MISSING_CREDENTIAL` 等）维持不注入。

## 0.0.7 — 2026-08-23

- **注入唤醒修复**：改用底层 `agent.send(msg, 'next-turn', true)`（显式 wakeup），注入后立即启动会话轮次。

## 0.0.6 — 2026-08-23

- **注入竞态与可观测性修复**：session-start 事件在 resume 前触发导致的误 disarm 修复；新增 `injectIfIdle` 直达注入；全决策分支补日志。

## 0.0.5 — 2026-08-23

- **全域化**：从单目标 → 扫描全部会话（`scanMode` 默认 true，`scanWindowMs` 24h）；interrupted → self-resume → idle 后注入；completed/settled 不动、运行中不打断。

## 0.0.4 — 2026-08-22

- **自我恢复补模型选择**：`installModelSelection`，恢复的 agent 带会话模型配置，prompt 组装不再报 `{{model}} has no value`。

## 0.0.3 — 2026-08-22

- **目标 agent 离线时自行 resume**：先直读持久化流判定，interrupted 则 `ctx.agents.resume()` 恢复后注入，无需等待浏览器打开。

## 0.0.2 — 2026-08-17

- 初始发布：重启后对固定目标会话注入「继续」。
