# QQ 无回复：会话恢复失败

## 原因与证据

2026-09-15 23:02:06、23:06:10、23:06:59、23:08:31（UTC+8），Host
收到用户消息后约 0.13–0.17 秒记录 `processing_failure`，没有 outbound。
服务和 QQ 连接在线，但主会话无法恢复；发送兜底位于恢复之后，因此未执行。

2026-09-16 在服务器临时目录复制 workspace、会话和模型选择配置，禁止网络、QQ
发送和模型调用，仅执行恢复及工具注册，复现：

```
SessionFormatUnsupportedError: event type "personal-growth/message-sent"
(seq 25397) unknown to this harness and not marked ignorable
```

根因是 Host 仅通过 TypeScript declaration merging 声明了自定义事件。
DSH 0.1.1-rc.2 的 PersistenceCoordinator 另用运行时事件目录检查磁盘日志；
该目录不包含外部插件事件。首次发送能写入，进程重启后再恢复则被拒绝。
之前测试只覆盖进程内发送，离线 smoke 未覆盖带自定义事件的持久化恢复。

## 修复方式及限制

在 send-message 模块加载时，通过限定兼容适配将唯一的 Host 自有事件
`personal-growth/message-sent` 加入 SDK 导出的运行时目录。该模块在会话读取前加载。
不改写或丢弃旧事件，不重复发送历史消息，其他未知事件仍拒绝读取。

这是对固定 SDK 版本的兼容适配：SDK 将目录声明为 ReadonlySet，但运行时实现为 Set，
且明确尚未提供外部事件注册 API。适配检查运行时形态，升级 SDK 时必须复核并优先
改用正式注册接口。不能将此方式扩展为允许任意未知事件。

SDK 读取器虽支持 ignorable，当前 Session.append 并未提供其写入参数，故本次没有采用
改写历史日志或给新事件添加无效参数的方案。

## 验证与复现

- 修复前服务器隔离恢复失败；加入限定目录项后同一会话副本恢复成功。
- 回归测试使用真实 PersistenceCoordinator 读取旧格式发送事件，并验证陌生事件仍拒绝。
- 完整 `verify` 通过：71 个测试文件、366 个测试，Lint、类型检查和生产构建通过。
- 部署前生产 `GET /api/schedules`（内部调用会话 inspect）返回 HTTP 500，作为部署后对照。
- `scripts/diagnose-agent-init.mjs` 从当前仓库复制数据到私有临时目录，禁用 fetch、QQ 发送，
  不发起 followup；服务器用 Node 24 执行并限制 30 秒。临时副本保留用于排查。
- 生产部署前停止服务并备份 runtime/workspace；不会将隔离副本覆盖回生产。

本次修复解决已确定的会话格式故障。初始化失败的通用兜底和更细粒度错误诊断仍是后续
可靠性改进项，不能把服务 ready 当作用户回复链路已验证。
