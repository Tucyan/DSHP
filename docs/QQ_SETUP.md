# QQ Setup

首版只接受一个固定 QQ 私聊用户。凭据只放在当前进程环境中，不写入配置文件、Memory、session 或 trace。DSH 相关包固定为 `0.1.1-rc.2`，生产通道使用 `@tencent-connect/qqbot-nodejs@1.0.4` 的 WebSocket transport。

在 PowerShell 中设置环境变量（不要写入仓库）：

```powershell
$env:QQBOT_APPID = '<QQ Bot App ID>'
$env:QQBOT_SECRET = '<QQ Bot Secret>'
$env:QQ_PEER_ID = '<唯一允许的 QQ Peer ID>'
```

先执行无网络 dry-run：

```powershell
.\scripts\start-runtime.ps1 -DryRun -LiveQQ -PeerId $env:QQ_PEER_ID
```

确认输出全部位于本仓库后，完成构建并正式启动：

```powershell
pnpm build
.\scripts\start-runtime.ps1 -LiveQQ -PeerId $env:QQ_PEER_ID
```

脚本会把凭据映射为 Host 内部使用的 `QQBOT_APP_ID`、`QQBOT_APP_SECRET` 与 `QQBOT_ALLOWED_PEER_ID`。缺少、空白或包含不安全字符的值会在连接前失败。

正式 Host 直接使用 DSH public Agent、Session、Schedule 与工具注册 API，并把 QQBot message 转为单用户前台会话。用户消息会先持久登记，再交给 Agent；该回合的长期 Memory 写入成功后才完成入站确认。Schedule 或 Foreground Heartbeat 产生的主动消息必须经过 quiet hours、cooldown 与 daily cap；Background Heartbeat 永远不能直接发送 QQ。非目标 peer、群消息和空消息会被忽略。

Host 状态保存在 `workspace/.personal-growth/bridge-state.json`。发送前已登记但远端结果不确定的消息会进入 unknown 状态，不会在重启时盲目重发；先人工核对 QQ 端，再通过 reconciliation API 标记结果。不要直接编辑或删除 ledger。真实 QQ 网络 smoke 必须由持有有效凭据的用户执行；无凭据自动化只证明本地适配、策略与恢复逻辑。
