# dsh-autoresume — dsh 会话重启自动续跑插件

会话进程重启后，若目标会话停在"被打断的中间态"（open turn / 无结果的 tool call / turn/end interrupted），
自动向该会话注入一条「继续」，让 agent 接着干活——无需人工干预。

## 特性

- 只服务**一个**配置的 `targetSessionId`，绝不扫描其他会话
- 通过 `ctx.sessionPersistence.inspect()` 读取会话持久化事件流做状态判定
- 判定逻辑：
  - **interrupted**（注入「继续」）：turn/step 打开未闭合、存在无对应 `tool/result` 的 `tool/call`、最后一个 `turn/end` 原因为 `interrupted`
  - **completed**（不动作）：最后是 `assistant/message`，或 `turn/end` 为 `completed` 且其后无新用户消息
  - **settled**（不动作）：`cancelled` / `error` 等已闭合终态；以及闭合轮次后出现的手动用户消息
- 注入方式：`ctx.agents.get(target)` → `agent.followup(userMessage)`（消息 `source.kind=plugin, form=notice`）
- **进程级一次性**：每个 web 进程只判定/注入一次；`bootGraceMs` 宽限窗口内有效（profile HMR 装卸插件不误触发）
- 目标会话未就绪时按 `pollIntervalMs` 重查

## 安装

```bash
# 1. 构建
npm run build

# 2. 注册到 web profile
dsh plugin --profile web add /path/to/dsh-autoresume

# 3. 配置目标会话（编辑 web profile 的 cordis.patch.yml）
- insert:
    - id: dsh-autoresume
      name: 'dsh-autoresume'
      config:
        targetSessionId: '<your-session-id>'   # 必填

# 4. 验证注册
dsh --profile web --dump-config   # 应出现 id: dsh-autoresume

# 5. 重启生效
sudo systemctl restart dsh-web
```

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `targetSessionId` | （必填） | 要自动续跑的目标会话 ID；未配置则插件不动作 |
| `bootGraceMs` | `120000` | web 进程启动后允许判定的宽限窗口（毫秒） |
| `initialDelayMs` | `3000` | 首次检查延迟（等会话恢复） |
| `pollIntervalMs` | `5000` | 会话未就绪时的重查间隔 |
| `promptText` | `继续（自动）` | 注入的续跑提示词 |

## 卸载

```bash
dsh plugin --profile web remove dsh-autoresume
```

## 工作原理简述

```
web 重启 → 插件加载 → 宽限窗口内 inspect(目标会话)
  ├─ interrupted → agent.followup(继续（自动）) → 自动接续
  ├─ completed / settled → 不动作（避免重复注入）
  └─ 会话未就绪 → 5s 后重查
```

## License

Apache-2.0
