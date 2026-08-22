# dsh-autoresume（重启后自动继续）

> 只服务一个配置的目标会话：`<your-session-id>`（必填）。
> web 进程重启后，若该会话停在被打断的中间态，就注入一条「继续」唤醒它接着干活。

## 行为
- 通过 `ctx.sessionPersistence.inspect()` 读取目标会话的持久化事件流（dsh-session 官方 API，底层即 `~/.dsh/sessions/<cwd>/<id>/session.jsonl.zstd` 的平衡视图）。
- 判定**被打断**：turn/step 打开未闭合、存在没有对应 `tool/result` 的 `tool/call`、或最后一个 `turn/end` 原因为 `interrupted`。
- 判定**已完成**：最后是 `assistant/message`，或最后一个 `turn/end` 为 `completed` 且其后没有新用户消息 → 不动作。
- 判定后不动作：`cancelled`/`error` 等已闭合终态，以及闭合轮次后新出现的手动用户消息。
- 注入方式：`ctx.agents.get(目标)` → `agent.followup(userMessage)`；消息 `source.kind=plugin, form=notice`，正文为「继续（自动）」。
- **进程级一次性**：每个 web 进程只判定/注入一次；另有 `bootGraceMs`（默认 120 秒）窗口，profile HMR 装卸插件不会误触发。
- **2026-08-22 修复（v0.1.1）**：目标会话 agent 不在线时不再干等到宽限过期。插件现在会先直接读持久化流判定状态（无需 agent 在线）；若判定为被打断，则自行 `ctx.agents.resume()` 恢复该会话（挂载会话当前 preset，与浏览器打开同构），随后注入「继续（自动）」。判定为已完成/已闭合则立即收手，不产生恢复副作用。
- **2026-08-22 修复（v0.1.2）**：自我恢复时补装模型选择（`installModelSelection`，读会话 requestHeader 模型配置，回退默认模型）。否则 prompt 组装报 `{{model}} has no value`、恢复出的 agent 跑不了轮。`@deepseek-ai/dsh-agent` 通过 peerDependencies 声明，由 dsh 宿主提供。
- 目标会话不在线时每 `pollIntervalMs`（默认 5 秒）重查，直到判定完成或宽限到期。

## 配置（cordis.patch.yml）
| 键 | 默认 | 说明 |
|---|---|---|
| `targetSessionId` | `<your-session-id>`（必填） | 只允许改这一个目标，绝不扫描其他会话 |
| `bootGraceMs` | `120000` | web 进程启动后允许判定的宽限窗口 |
| `initialDelayMs` | `3000` | 首次检查延迟（等会话恢复） |
| `pollIntervalMs` | `5000` | 会话未就绪时的重查间隔 |
| `promptText` | `继续（自动）` | 注入正文 |

## 安装与验证
```bash
dsh plugin --profile web add dsh-autoresume
dsh --profile web --dump-config   # 应出现 id: dsh-autoresume、name: dsh-autoresume
```
装完**不要立即重启**；等开发完成后再 `sudo systemctl restart dsh-web` 生效。
依赖说明：`@deepseek-ai/dsh-agent`（含 `installModelSelection`）由 dsh 宿主提供，通过 peerDependencies 声明，无需单独安装。
实测（2026-08-17）：重启后目标会话日志出现 `user/message`（`source.plugin=dsh-autoresume`，正文「继续」），开发会话自动接续；每进程只注入一次。
实测（2026-08-22 v0.1.2）：真实会话双测全链路通过——early inspect（7s）→ self-resumed → 注入「继续（自动）」→ request/header 带出会话模型 → agent 正常继续干活，无 {{model}} 报错。

## 卸载/禁用
- 卸载：`dsh plugin --profile web remove dsh-autoresume`
- 热禁用：在 web profile `cordis.patch.yml` 给 `dsh-autoresume` 入口加 `disabled: true`。
