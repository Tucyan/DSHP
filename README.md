# Personal Growth Agent v0.1

一个面向单一固定用户的长期成长 Agent。DSH 提供运行时能力，本仓库提供受控的 Agent Core、长期 Memory、Foreground/Background Heartbeat、QQ/DSH 适配器和本地无凭据验收 Demo。

## 快速体验

交互式运行架构：运行 `pnpm architecture` 后打开 `http://127.0.0.1:3181`，或直接用浏览器打开 [架构页面](docs/explorer/index.html)。页面展示六种流程与数据归属，使用静态示例，不连接 Agent。

```text
pnpm install        # 仅首次安装依赖；不要在运行时重复安装
pnpm demo           # 无凭据，使用临时/隔离运行目录完成完整闭环
pnpm verify         # lint、类型检查、测试、构建
```

正式运行前请阅读 [docs/OPERATIONS.md](docs/OPERATIONS.md) 与 [docs/QQ_SETUP.md](docs/QQ_SETUP.md)。默认数据位于项目 `runtime/` 和 `workspace/`，不会使用用户已有的 `~/.dsh` 或 `~/.agents`。

Windows 下可先检查正式启动参数而不连接 QQ：

```powershell
.\scripts\start-runtime.ps1 -DryRun -LiveQQ -PeerId '<固定用户 Peer ID>'
```

真实 QQ 启动使用独立的 DSH Host Bridge；它直接组合 DSH public Agent/Session/Schedule API 与腾讯 QQBot WebSocket，不依赖旧的 Web Profile QQ overlay。

## v0.1 交付边界

- QQ 单用户接入、跨重启的绑定与主动消息 ledger。
- 对话增量压缩、Dream proposal、Memory Tree 和 PROFILE/INDEX 派生投影。
- 前台联系策略（quiet hours、cooldown、daily cap）和后台隐藏反思。
- Skill 创建需输入/输出/停止条件、正反触发器和版本化验证；Plugin 仅生成待审批 proposal。
- 本地 deterministic Demo 覆盖 QQ → 回复 → Memory → 后台 → 主动联系 → 反馈闭环。

Live QQ 需要用户自行配置凭据；没有凭据时应使用 Demo 或 dry-run，不会读取真实凭据。

## 当前验收边界

自动化验收可覆盖隔离、恢复、单用户授权、Memory、Heartbeat、Schedule、Skill/Plugin proposal 与脱敏 Trace。真实 QQ 网络和真实模型回复需要有效的 QQBot 凭据、固定 Peer ID 及 DSH 默认模型配置，因此不会在无凭据环境中伪造“已上线”结果。
# Web 管理台

正式 Host 启动后访问 `http://127.0.0.1:3182`，使用 `pnpm admin:token` 获取本地登录 Token。
支持运行监测、只读会话切换、Memory、SOUL/Mission、Heartbeat、Schedule 与诊断。
首次升级运行 `pnpm install`、`pnpm build`。详见 [Web 管理台说明](docs/WEB_ADMIN.md)。
