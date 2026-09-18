<p align="center">
  <img src="assets/logo.svg" width="96" alt="dsh-autoresume logo">
</p>

<h1 align="center">dsh-autoresume</h1>

<p align="center">
  <strong>Web 重启 / 上游故障后自动注入「继续」</strong> —— 会话停在中间态，插件替你接上，不用手动点。
</p>

<p align="center">
  <a href="https://github.com/shengyvself/dsh-autoresume/releases">
    <img src="https://img.shields.io/github/v/release/shengyvself/dsh-autoresume?style=flat-square&label=release&color=4D6BFE" alt="Release">
  </a>
  <a href="https://github.com/shengyvself/dsh-autoresume">
    <img src="https://img.shields.io/github/stars/shengyvself/dsh-autoresume?style=flat-square&label=stars&color=4D6BFE" alt="Stars">
  </a>
  <img src="https://img.shields.io/badge/license-Apache--2.0-0B7285?style=flat-square" alt="Apache-2.0">
  <img src="https://img.shields.io/badge/DSH-0.1.0--rc.5+-4D6BFE?style=flat-square" alt="DSH 0.1.0-rc.5+">
  <img src="https://img.shields.io/badge/Web-4D6BFE?style=flat-square" alt="DSH Web">
</p>

<p align="center">
  <a href="./README.en.md">English</a> · <strong>中文</strong>
</p>

<p align="center">
  <a href="assets/hero.svg">
    <img src="assets/hero.svg" width="100%" alt="三步工作流：Web 重启/上游故障 → 插件判定 → 注入「继续」；下方四个安全网">
  </a>
</p>

## 你拿到什么

- 🔁 **Web 重启自动接续** —— dsh web 重启后，插件扫描全部会话，把被打断的任务自动接上；completed / settled / cancelled 一律不动。
- 🌐 **上游瞬时故障自愈** —— 限流（429）、5xx、网络错误（ECONNRESET / timeout）、网关 504、上游 provider 故障——插件注入「继续」让会话自动重跑。
- 💳 **余额/配额类识别** —— 402 / QUOTA / insufficient_balance / insufficient_quota 等：首次注入一次（覆盖充值后恢复），再次失败一律转 settled，防无限循环。
- 🛡️ **死循环守卫** —— 注入后若无产出再失败，判定为持续故障，转 settled 交还用户手动处理；会话之后有产出或新用户消息则重新武装。
- 📥 **队列守卫** —— inbox 里若有**别人**（用户/客户端）的挂起消息，插件一律不动作（既不注入也不 resume），避免把用户消息一并唤醒冲进会话。
- ⏱️ **liveWatch 持续监听** —— boot 扫描后保持轮询，补 catch 运行期间**再次**失败（此前只有 web 重启后一次性生效）。
- 🔢 **连续两次自动继续** —— 网络瞬时类（429 / 限流）允许注入 → 败 → 再注入 → 败 → 停，适配长限流窗口场景；余额类保持「一次即停」。
- 🌍 **跨平台** —— Linux / macOS / Windows 行为一致（`os.homedir()` + `node:path`），路径分隔自动适配。

## Install

```sh
dsh plugin --profile web add dsh-autoresume
```

安装后**重启 `dsh web`**。插件会在 boot 宽限窗口（默认 30 分钟，可配 `bootGraceMs`）内自动扫描并注入。

**Requires DSH client packages >=0.1.0-rc.5.** 依赖 `@deepseek-ai/dsh-agent`（复用 DSH 运行时同一份，版本零漂移）。

也可以从 GitHub 直装：

```sh
dsh plugin --profile web add github:shengyvself/dsh-autoresume
```

## 用它能干嘛

装好后，正常用即可——插件在后台自动工作。典型场景：

- "我刚才改了代码重启了 dsh web" —— 插件自动扫描，把被打断的开发会话接上
- "上游模型临时限流了" —— 429 / rate_limit_exceeded 后插件注入「继续」，会话自动重跑
- "刚才那个 504 网关超时" —— 网关 HTML 错误信封递归解包，正确判网络故障，注入「继续」
- "余额不够，充值了" —— 首次 402 注入一次（覆盖充值后恢复），不再次失败时自动转 settled

插件不主动发起任何动作，只在 web 重启或 liveWatch 轮询时判定并注入。

## 兼容性

| 场景 | DSH 版本 | 插件版本 |
|---|---|---|
| **推荐** | **`0.1.5-rc.2+`**（当前维护版） | **`0.0.21`** |
| 最低兼容 | `0.1.0-rc.5+` | `0.0.21` |

安装插件**不会**升级宿主 DSH。peerDependencies 声明的最低客户端包版本是 `>=0.1.0-rc.5`，实测在 `0.1.5-rc.2` 上跑通。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `targetSessionId` | 全域扫描 | 指定会话时只服务该会话（兼容模式） |
| `bootGraceMs` | `30000`（30 分钟） | web 启动后允许判定的宽限窗口 |
| `initialDelayMs` | `3000` | 首次检查延迟 |
| `pollIntervalMs` | `5000` | 会话未就绪时的重查间隔 |
| `promptText` | `继续（自动）` | 注入正文 |
| `liveWatch` | `true` | boot 后保持轮询补 catch 运行期间再次失败 |
| `maxResumeAttempts` | `2` | 网络瞬时类连续自动继续次数上限 |
| `skipWhenInputPending` | `true` | 队列守卫：inbox 有非我方挂起消息时不注入 |

## Security

- 只读会话事件流（`ctx.sessionPersistence`），**不写**用户文件。
- 注入的消息以 plugin 身份（`source.kind=plugin, form=notice`）发送，不伪装用户消息。
- 不联网。除调用 DSH 内部 `ctx.agents.get()` / `agent.followup()` 之外，无对外网络请求。
- 死循环守卫 + 余额类防无限循环 + 队列守卫三重保护，避免误伤。

## 依赖说明

`@deepseek-ai/dsh-agent` 声明在 `peerDependencies`（由宿主 DSH 提供）。

⚠️ 已知问题：`package.json` 的 `dependencies` 里也列了 `@deepseek-ai/dsh-agent: 0.1.1-rc.2`——这违反 persona §三.1.3 铁律（官方 `@deepseek-ai/*` 包只进 peerDependencies）。当前安装方式是手动 symlink 复用 DSH 运行时同一份，避免版本漂移。下一版会清理。

## 版本历史

完整 changelog 见 [`CHANGELOG.md`](./CHANGELOG.md)。关键里程碑：

- **v0.0.21**（2026-09-13）：自动继续恢复链路修复（0.1.5 `inspect()` 移除 → 改 `open/read/close`；`AgentSetup` 回调签名变更）
- **v0.0.19**（2026-09-13）：队列守卫 + DSH 0.1.5 会话代际适配
- **v0.0.18**（2026-09-08）：连续两次自动继续（商汤日日新裁决）
- **v0.0.17**（2026-09-02）：tpm/rpm 限流识别
- **v0.0.16**（2026-09-01）：启动崩溃修复（防御 `getAgent()`）
- **v0.0.15**（2026-09-01）：402/400/中文瞬时可继续 + 余额类防无限循环
- **v0.0.13**（2026-08-31）：OpenRouter 上游 provider 故障识别
- **v0.0.12**（2026-08-31）：504/网关超时递归信封解包
- **v0.0.9**（2026-08-24）：liveWatch + 死循环守卫
- **v0.0.8**（2026-08-24）：网络故障停止识别

## 构建与开发

```bash
npm run build
npm test
```

## License

[Apache License 2.0](./LICENSE) © shengyvself
