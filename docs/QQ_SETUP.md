# QQ Setup

首版使用固定私聊 peer。配置至少包括 `peerId`、`appId` 和环境变量名 `appSecretEnv`；凭据只放在进程环境中，不写入配置文件、Memory、sessions 或 trace。项目固定使用 `@tencent-connect/dsh-qqbot@0.4.0`，DSH 固定 `@deepseek-ai/dsh@0.1.1-rc.2`。

先运行本地 `pnpm demo` 或 dry-run，确认单用户 gate、主动消息 ledger、重启恢复和隔离路径。正式运行时只通过 Tencent adapter 的 transport 发送私聊；后台 heartbeat 没有 QQ 发送权限。收到非目标 peer、群消息或空消息会被忽略。

由于 QQ bundle 的公开导出只提供 Cordis `apply(ctx, config)`，不暴露 inbound/transport 对象，Runtime 的 Live composition 采用明确的 Host Bridge：宿主负责把官方 QQ session/event 转成 `AsyncIterable<QqInbound>`、提供 `QqTransport` 和 DSH `DshLiveScheduleTool`，再传给 `createLiveRuntime()` 或 `runLive()`。Runtime 使用真实 `DurableQqPort` 和 `LiveDshSchedule`，并启动可停止的 inbound loop；不会伪造 bundle 的内部 API。真实 QQ 网络 smoke 仍需凭据。

若发送结果不确定，保留 `runtime/storage/qq-binding.json` 中的 pending 状态，人工核对 QQ 端后再 reconcile；不要直接删除 ledger 或盲目重发。Live mode 缺少环境变量时必须清晰失败，且不尝试读取其他凭据来源。
