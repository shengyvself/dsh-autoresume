# Changelog

本文件记录 dsh-autoresume 的发布版本变更。版本号与 package.json 同步。

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
