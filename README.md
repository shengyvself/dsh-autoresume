# dsh-autoresume（重启后自动继续）

> **全域模式（v0.0.5，2026-08-23）**：web 重启后，**任何被重启中断任务的会话**都会自动继续——扫描 `~/.dsh/sessions` 全部会话（仅处理最后活动在 `scanWindowMs`（默认 24h）内的），持久化事件流停在被打断中间态的注入「继续」；completed/settled 一律不动；正在运行的会话绝不打断。
> **网络故障停止（v0.0.8，2026-08-24）**：会话因**网络/瞬时故障**停止（最后一个 `turn/end` 为 `error`，错误码属 DSH 可重试集合 `EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT` 及 429 直出码 `rate_limit_exceeded`/`too_many_requests`，或消息命中网络特征如 `upstream error`/`429`/`5xx`/`timeout`/`fetch failed`/`ECONNRESET`/`service temporarily unavailable`；支持 DSH/OpenAI 风格错误信封 `{error:{code,type,message}}`（含 `type=service_unavailable`））同样注入「继续（自动）」让其自动重跑；**配置/模型类错误**（`UNKNOWN_MODEL`/`MISSING_CREDENTIAL`/`NO_ADAPTER` 等）维持 settled 不注入，避免死循环。
> 兼容模式：配置 `targetSessionId` 时退化为旧行为（只服务该会话）。
> **运行期间再次网络失败（v0.0.9，2026-08-24）**：`liveWatch`（默认 true）使插件在 boot 扫描后保持轮询，补 catch 同一会话在运行期间**再次**以网络/瞬时失败停止（此前只有在 web 重启后才一次性生效）；并加**死循环守卫**——若上次注入「继续」之后未产生任何内容/工具调用便再次以同类网络错误失败（模型持续返回空内容，例如某些强制推理的隐身模型），判定为持续故障转 `settled` 不再注入，交由用户手动处理；会话之后有产出或新用户消息则重新武装。
> **永久守护（v0.0.10，2026-08-27）**：`bootGraceMs` 默认由 30 分钟改为 `Infinity`——宽限窗口永不触发 disarm，运行期任意时刻的再次网络/瞬时失败都由 `liveWatch` 持续补捞（`lastSeenMtime` 缓存：会话 mtime 未变即跳过，0 开销）；限流/瞬时失败后长时间静止的会话不再因超窗被错过。可显式配置 `bootGraceMs` 数值回归旧行为。
> **触发场景清单（v0.0.10.1，2026-08-28）**：本插件对以下三类事件自动注入「继续（自动）」：
> 1. **大模型拥挤 / 排队**——上游限流 429（错误码 `RATE_LIMIT` / `rate_limit_exceeded` / `too_many_requests`），或返回 `type=service_unavailable`，或消息命中 `currently overloaded` / `please try again later` / `all endpoints are currently overloaded` / `\b5\d\d\b` 等特征。属于"等一会儿就能恢复"的瞬时故障，自动接着跑。
> 2. **上游网络 / 服务端故障**——错误码 `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE`，或消息命中网络特征正则 `NETWORK_FAILURE_PATTERN`（`upstream error` / `internal server error` / `service temporarily unavailable` / `timed out` / `fetch failed` / `econnreset` / `econnrefused` / `etimedout` / `socket hang up` / `network error` / `connection refused|reset|closed`）。
> 3. **DSH web 重启 / 崩溃造成 turn 停在中间态**——`turn/start` 后无 `turn/end`、`step/start` 后无 `step/end`、有 `tool/call` 但无对应 `tool/result`、或最后一个 `turn/end` 原因 = `interrupted`。
>
> **不动的场景**（避免误注入 / 死循环）：已完成（`assistant/message` / `turn/end reason=completed`）、`cancelled`、非网络类 error（配置/模型错误如 `UNKNOWN_MODEL` / `MISSING_CREDENTIAL` / `NO_ADAPTER` / `INVALID_MODEL_INFO`）、闭合轮次后的新用户消息。
>
> **死循环守卫**：上一次注入「继续」之后若模型**没有产生任何内容或工具调用**又以同类网络错误失败（典型如某些隐身模型过载时持续返回空内容），自动转 `settled` 不再注入，交还用户。会话有产出或新用户消息时自动重新武装。

## 行为
- 通过 `ctx.sessionPersistence.inspect()` 读取目标会话的持久化事件流（dsh-session 官方 API，底层即 `~/.dsh/sessions/<cwd>/<id>/session.jsonl.zstd` 的平衡视图）。
- 判定**被打断**：turn/step 打开未闭合、存在没有对应 `tool/result` 的 `tool/call`、或最后一个 `turn/end` 原因为 `interrupted`。
- 判定**网络故障停止**：最后一个 `turn/end` 原因为 `error` 且错误属网络/瞬时故障（错误码在 DSH 可重试集合（含 429 直出码 `rate_limit_exceeded`）或 `type=service_unavailable`，或消息命中网络特征正则 `NETWORK_FAILURE_PATTERN`（支持 `{error:{...}}` 信封解包））→ 同样注入「继续（自动）」；配置/模型类 error（如 `UNKNOWN_MODEL`/`MISSING_CREDENTIAL`/`NO_ADAPTER`/`INVALID_MODEL_INFO`）维持 settled 不注入。
- 判定**已完成**：最后是 `assistant/message`，或最后一个 `turn/end` 为 `completed` 且其后没有新用户消息 → 不动作。
- 判定后不动作：`cancelled`/`error` 等已闭合终态，以及闭合轮次后新出现的手动用户消息。
- 注入方式：`ctx.agents.get(目标)` → `agent.followup(userMessage)`；消息 `source.kind=plugin, form=notice`，正文为「继续（自动）」。
- **进程级一次性（liveWatch 关闭时）**：每个 web 进程只判定/注入一次；另有 `bootGraceMs`（v0.0.10 起默认 `Infinity`——永久守护窗口，可显式配置数值回归旧行为）窗口，profile HMR 装卸插件不会误触发。`liveWatch: true`（默认）时在 `bootGraceMs` 窗口内持续重扫（仅处理每会话 mtime 变化者，避免反复读大事件流），补 catch 运行期间的再次网络失败；`isResumableState` 的 loop-guard 对「continue→无产出再失败」转 settled，防模型持续空返回死循环。
- **2026-08-22 修复（v0.0.3）**：目标会话 agent 不在线时不再干等到宽限过期。插件现在会先直接读持久化流判定状态（无需 agent 在线）；若判定为被打断，则自行 `ctx.agents.resume()` 恢复该会话（挂载会话当前 preset，与浏览器打开同构），随后注入「继续（自动）」。判定为已完成/已闭合则立即收手，不产生恢复副作用。
- **2026-08-22 修复（v0.0.4）**：自我恢复时补装模型选择（`installModelSelection`，读会话 requestHeader 模型配置，回退默认模型）。否则 prompt 组装报 `{{model}} has no value`、恢复出的 agent 跑不了轮。依赖 `@deepseek-ai/dsh-agent` 用符号链接复用运行时副本（npm 装会 peer 冲突），安装方式见下。
- 目标会话不在线时每 `pollIntervalMs`（默认 5 秒）重查，直到判定完成或宽限到期。

## 配置（cordis.patch.yml）
| 键 | 默认 | 说明 |
|---|---|---|
| `targetSessionId` | 上面写死的开发会话 | 只允许改这一个目标，绝不扫描其他会话 |
| `bootGraceMs` | `Infinity` | web 进程启动后允许判定的宽限窗口（v0.0.10 起默认永久不 disarm，可配数值回归旧行为） |
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
dsh plugin --profile web add /path/to/dsh-autoresume
dsh --profile web --dump-config   # 应出现 id: dsh-autoresume、name: dsh-autoresume
```
装完**不要立即重启**；等开发完成后再 `sudo systemctl restart dsh-web` 生效。
实测（2026-08-17）：重启后目标会话日志出现 `user/message`（`source.plugin=dsh-autoresume`，正文「继续」），开发会话自动接续；每进程只注入一次。
实测（2026-08-22 v0.0.4）：真实会话双测全链路通过——early inspect（7s）→ self-resumed → 注入「继续（自动）」→ request/header 带出会话模型（deepseek-v4-flash）→ agent 正常继续干活，无 {{model}} 报错。

## 卸载/禁用
- 卸载：`dsh plugin --profile web remove dsh-autoresume`
- 热禁用：在 web profile `cordis.patch.yml` 给 `dsh-autoresume` 入口加 `disabled: true`。
