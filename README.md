# dsh-autoresume（重启后自动继续）

> **全域模式（v0.0.5，2026-08-23）**：web 重启后，**任何被重启中断任务的会话**都会自动继续——扫描 `~/.dsh/sessions` 全部会话（仅处理最后活动在 `scanWindowMs`（默认 24h）内的），持久化事件流停在被打断中间态的注入「继续」；completed/settled 一律不动；正在运行的会话绝不打断。
> **网络故障停止（v0.0.8，2026-08-24）**：会话因**网络/瞬时故障**停止（最后一个 `turn/end` 为 `error`，错误码属 DSH 可重试集合 `EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT` 及 429 直出码 `rate_limit_exceeded`/`too_many_requests`，或消息命中网络特征如 `upstream error`/`429`/`5xx`/`timeout`/`fetch failed`/`ECONNRESET`/`service temporarily unavailable`；支持 DSH/OpenAI 风格错误信封 `{error:{code,type,message}}`（含 `type=service_unavailable`））同样注入「继续（自动）」让其自动重跑；**配置/模型类错误**（`UNKNOWN_MODEL`/`MISSING_CREDENTIAL`/`NO_ADAPTER` 等）维持 settled 不注入，避免死循环。
> **504/网关超时强化（v0.0.12，2026-08-31）**：错误信封解包改为**递归**（任意深度 `{error:{...}}` 嵌套、`failure` 负载字段均剥到最内层），`NETWORK_FAILURE_PATTERN` 补 `gateway time-?out` 特征——外部环境 504 Gateway Time-out（ALB 网关超时 HTML）无论以单层/多层信封、带/不带状态码数字呈现均正确判 network-stopped 注入。
> **OpenRouter 上游 provider 故障（v0.0.13，2026-08-31）**：`NETWORK_FAILURE_PATTERN` 补 `provider returned error` 特征——OpenRouter 对上游 provider（如 minimax）故障的标准文案（pi-ai adapter 兜底归类 `PI_AI_ERROR`，属瞬时上游故障、同 provider 稍后可恢复）同样判 network-stopped 注入。
> **402/400/中文瞬时可继续（v0.0.15，2026-09-01）**：① 402/余额类（`QUOTA`/`insufficient_balance`/`payment_required`/`402`/`insufficient balance`）注入后**再次以余额类错误失败一律转 `settled`**——余额不足是持久性状态（充值/换 provider 前每次调用必失败），防「真没余额」时自动继续无限循环（此前 usage/finish 元数据被误计为产出导致 loop-guard 失效）；首次 402 仍注入一次（覆盖充值后恢复）。② `400 status code (no body)`（tokenrhythm 兜底形态）与中文瞬时特征（`模型服务暂时不可用`/`请稍后重试`/`当前繁忙` 等）判 network-stopped 注入；新增 `PERMANENT_LLM_CODES` 排除永久码（`UNKNOWN_MODEL`/`CONTEXT_WINDOW_EXCEEDED` 等）——上下文超限即使携带 400 message 也 settled 不注入。
> **启动崩溃修复（v0.0.16，2026-09-01）**：`ctx.agents` 是惰性注入服务，在插件上下文未活性/服务注入未就绪时直接访问会触发 cordis `inactive context` 守卫拦截 → 插件树加载 fatal 崩溃循环（DSH 0.1.2-alpha.3 升级后实证）。`checkOnce()`/`injectIfIdle()` 改用防御助手 `getAgent()`（try/catch 捕获异常 → warn 降级 → 返回 undefined，下轮 poll 重试），不再中断插件树加载。
> 兼容模式：配置 `targetSessionId` 时退化为旧行为（只服务该会话）。
> **运行期间再次网络失败（v0.0.9，2026-08-24）**：`liveWatch`（默认 true）使插件在 boot 扫描后保持轮询，补 catch 同一会话在运行期间**再次**以网络/瞬时失败停止（此前只有在 web 重启后才一次性生效）；并加**死循环守卫**——若上次注入「继续」之后未产生任何内容/工具调用便再次以同类网络错误失败（模型持续返回空内容，例如某些强制推理的隐身模型），判定为持续故障转 `settled` 不再注入，交由用户手动处理；会话之后有产出或新用户消息则重新武装。

## 行为
- 通过 `ctx.sessionPersistence.inspect()` 读取目标会话的持久化事件流（dsh-session 官方 API，底层即 `~/.dsh/sessions/<cwd>/<id>/session.jsonl.zstd` 的平衡视图）。
- 判定**被打断**：turn/step 打开未闭合、存在没有对应 `tool/result` 的 `tool/call`、或最后一个 `turn/end` 原因为 `interrupted`。
- 判定**网络故障停止**：最后一个 `turn/end` 原因为 `error` 且错误属网络/瞬时故障（错误码在 DSH 可重试集合（含 429 直出码 `rate_limit_exceeded`）或 `type=service_unavailable`，或消息命中网络特征正则 `NETWORK_FAILURE_PATTERN`（含 OpenRouter 上游 provider 故障文案 `provider returned error`，支持 `{error:{...}}` 信封解包））→ 同样注入「继续（自动）」；配置/模型类 error（如 `UNKNOWN_MODEL`/`MISSING_CREDENTIAL`/`NO_ADAPTER`/`INVALID_MODEL_INFO`）维持 settled 不注入。
- 判定**已完成**：最后是 `assistant/message`，或最后一个 `turn/end` 为 `completed` 且其后没有新用户消息 → 不动作。
- 判定后不动作：`cancelled`/`error` 等已闭合终态，以及闭合轮次后新出现的手动用户消息。
- 注入方式：`ctx.agents.get(目标)` → `agent.followup(userMessage)`；消息 `source.kind=plugin, form=notice`，正文为「继续（自动）」。
- **进程级一次性（liveWatch 关闭时）**：每个 web 进程只判定/注入一次；另有 `bootGraceMs`（默认 30 分钟）窗口，profile HMR 装卸插件不会误触发。`liveWatch: true`（默认）时在 `bootGraceMs` 窗口内持续重扫（仅处理每会话 mtime 变化者，避免反复读大事件流），补 catch 运行期间的再次网络失败；`isResumableState` 的 loop-guard 对「continue→无产出再失败」转 settled，防模型持续空返回死循环。
- **2026-08-22 修复（v0.0.3）**：目标会话 agent 不在线时不再干等到宽限过期。插件现在会先直接读持久化流判定状态（无需 agent 在线）；若判定为被打断，则自行 `ctx.agents.resume()` 恢复该会话（挂载会话当前 preset，与浏览器打开同构），随后注入「继续（自动）」。判定为已完成/已闭合则立即收手，不产生恢复副作用。
- **2026-08-22 修复（v0.0.4）**：自我恢复时补装模型选择（`installModelSelection`，读会话 requestHeader 模型配置，回退默认模型）。否则 prompt 组装报 `{{model}} has no value`、恢复出的 agent 跑不了轮。依赖 `@deepseek-ai/dsh-agent` 用符号链接复用运行时副本（npm 装会 peer 冲突），安装方式见下。
- 目标会话不在线时每 `pollIntervalMs`（默认 5 秒）重查，直到判定完成或宽限到期。

## 配置（cordis.patch.yml）
| 键 | 默认 | 说明 |
|---|---|---|
| `targetSessionId` | 上面写死的开发会话 | 只允许改这一个目标，绝不扫描其他会话 |
| `bootGraceMs` | `120000` | web 进程启动后允许判定的宽限窗口 |
| `initialDelayMs` | `3000` | 首次检查延迟（等会话恢复） |
| `pollIntervalMs` | `5000` | 会话未就绪时的重查间隔 |
| `promptText` | `继续（自动）` | 注入正文 |
| `liveWatch` | `true` | boot 后保持轮询补 catch 运行期间再次网络/瞬时失败；配 loop-guard 防模型持续空返回死循环 |

## 安装与验证
```bash
npm run build
# v0.0.4 起依赖 @deepseek-ai/dsh-agent：npm 直装会 peer 冲突（dsh-brand rc.8 vs rc.2），
# 用符号链接复用运行时同一份（版本零漂移）：
mkdir -p node_modules/@deepseek-ai
ln -sfn /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent node_modules/@deepseek-ai/dsh-agent
node --input-type=module -e "import('./lib/service.js').then(()=>console.log('loads ok'))"
dsh plugin --profile web add /path/to/dsh-autoresume   # 替换为实际插件目录
dsh --profile web --dump-config   # 应出现 id: dsh-autoresume、name: dsh-autoresume
```
装完**不要立即重启**；等开发完成后再 `sudo systemctl restart dsh-web` 生效。
实测（2026-08-17）：重启后目标会话日志出现 `user/message`（`source.plugin=dsh-autoresume`，正文「继续」），开发会话自动接续；每进程只注入一次。
实测（2026-08-22 v0.0.4）：真实会话双测全链路通过——early inspect（7s）→ self-resumed → 注入「继续（自动）」→ request/header 带出会话模型（deepseek-v4-flash）→ agent 正常继续干活，无 {{model}} 报错。

## 卸载/禁用
- 卸载：`dsh plugin --profile web remove dsh-autoresume`
- 热禁用：在 web profile `cordis.patch.yml` 给 `dsh-autoresume` 入口加 `disabled: true`。
