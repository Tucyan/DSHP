# 运行架构交互页面

直接在浏览器打开本目录的 `index.html`，无需安装依赖或启动 Agent。也可在仓库根目录运行 `pnpm architecture`，访问终端显示的本地地址。默认端口 3181，与 DSH Web 的 3180 分离。

页面包含六种可逐步播放的场景：QQ 对话、长期记忆、前台 Heartbeat、后台维护、定时任务、重启恢复。节点与时间线可点击，下方标签切换持久化文件说明。支持移动屏幕、键盘操作和暂停播放。

所有内容是内置示例，不读取运行目录、凭据或实际聊天，不发送 QQ 消息。说明依据 2026-09 的 v0.1 本地源码，不能作为运行健康检查。

## 已标明的实现边界

- 默认 Host `wakeForeground` 未返回 `result`，Bridge 的主动发送分支依赖返回值。前台 Heartbeat 与 Schedule 均标明此缺口。
- 当前 Host compressor 拼接消息角色和文本，尚非模型语义摘要。
- 正式 Host 入站账本保留消息 ID / 租约；本地 Runtime durable inbox 的 payload 恢复能力不能自动等同于生产 Host。
- SOUL / AGENT 文件存在不代表已由正式 Host 显式注入；需依据 DSH 指令加载行为核实。

变更这些生产实现后，请同步更新 `app.js` 中的场景说明。
