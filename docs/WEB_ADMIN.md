# Web 管理台

管理台随正式 QQ Host 一起启动，默认地址为 http://127.0.0.1:3182。
它不是独立进程管理器；Host 停止后页面显示连接中断。
架构展示页仍使用 `pnpm architecture`，与管理台独立。

## 首次使用

1. 在项目根目录执行 `pnpm install` 和 `pnpm build`。
2. 使用已有本地启动脚本 `runtime/credentials/start-live.local.ps1` 启动 Agent。
3. 首次启动会自动生成 `runtime/credentials/admin-token.json`，该目录不会提交到 Git。
4. 在另一个项目终端执行 `pnpm admin:token`，将显示的 Token 输入登录页。

Token 仅通过本地文件或显式命令获取，不出现在启动日志、URL 或浏览器持久化存储。
登录 Cookie 有效期为 8 小时。执行 `pnpm admin:token:rotate` 会轮换 Token，
既有登录与事件流在下次请求或数秒内失效。退出登录只撤销当前登录。
请勿分享 Token 或开放端口；只支持 `127.0.0.1`，不支持 localhost 别名或远程代理。

可在启动前设置 `$env:PGA_ADMIN_PORT = '3184'` 更改端口。
端口冲突会明确报错，不会连接其他进程或静默切换地址。

## 管理边界

- 会话切换只改变阅读区，不改变 QQ 活跃会话，也不发送消息。后台会话默认不显示，勾选后可查看。
- 会话内容按事件序号增量读取，工具调用默认折叠。内容作为文本显示，不执行 HTML，也不加载外部图片。
- Memory 新增使用相对路径，例如 `preferences/study-time.md`；编辑与归档有并发版本检查。
- PROFILE 和 INDEX 为自动生成结果，不可直接修改。修订记录是操作与 hash 元数据，不是完整历史快照。
- SOUL、Mission 保存后从每个 Agent 的下一轮开始生效，当前轮保持原版本。后台提示词和安全权限只读。
- 提示词版本存放于 `runtime/admin/prompts.json`，SOUL.md/AGENT.md 是其投影。启用管理编辑后，应通过页面修改，不要同时手动改这两个文件。
- Heartbeat 的暂停状态、周期和策略存放于 `runtime/admin/heartbeat.json`，重启保持；暂停不打断已开始的任务。
- 手动前台检查可能发送 QQ，但仍受安静时段、冷却和日上限限制。NOOP 是正常结果，后台维护不会直接外发。
- Schedule 仅创建或删除固定前台会话的官方任务。浏览任务列表不会唤醒历史会话；显式创建/删除可能准备固定前台 Agent。QQ 主动发送仍受平台额度与规则约束。
- Skills 和 Plugin 提案只读，不提供代码执行或自动部署入口。
- 诊断展示有界的最近记录，原始日志仍保留于隔离运行目录；审计只记录操作类型、时间和结果，不记录正文或密钥。

## 验证与开发

`pnpm verify` 包含后端测试、前端模型测试、类型检查和生产页面构建。
生产 Host 提供构建资源与 API，同源运行，不依赖 Vite 开发服务器。
前端单独运行 `pnpm --filter @personal-growth/admin-web dev` 只用于布局开发；
鉴权联调应使用 Host 同源服务，避免跨域代理削弱 Origin 校验。

管理台目前不提供进程启停、浏览器聊天、QQ 用户绑定切换、模型密钥编辑、永久删除 Memory 或恢复历史 Memory 内容。

### 本次验收记录

- `pnpm verify` 通过：lint、类型检查、60 个测试文件 / 299 项测试、生产构建。
- 隔离测试实例已通过浏览器登录、会话查看/切换、Memory 新增、SOUL 保存、后台 NOOP、退出及断线提示验收；桌面和 390px 窄屏已检查。
- 真实 Host 启动时曾成功提供管理 HTTP 服务，但当前执行环境向腾讯申请访问令牌被网络权限拒绝；未重复尝试。真实 QQ/模型联调和官方 Schedule 重启验证尚需在用户终端执行，不能用隔离测试结果代替。
- 临时验收进程已停止，不占用正式管理端口。再次使用请按“首次使用”启动正式 Agent。
