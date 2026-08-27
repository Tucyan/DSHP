# Security boundary

这是单用户本地部署，不是多租户安全边界。Runtime 会把 DSH_HOME、DSH_AGENTS_HOME、workspace、plugins、skills、sessions、storage、credentials 放到项目隔离路径，并拒绝默认 `~/.dsh`、`~/.agents`、路径遍历、现有 symlink/junction 和跨根路径。凭据只允许通过环境变量引用。

Memory Tree 只能由 MemoryService 写入；Dream 无文件系统能力；background heartbeat 只能写隐藏 session，不能 RESPOND 或 MESSAGE_USER，也不能直接发 QQ。前台联系受 occurrence、quiet hours、cooldown、daily cap 和 QQ outbound ledger 保护。Skill writer 只在隔离 Agents home 创建单独版本目录，覆盖已有文件、宽泛触发、个人事实和 secret 均拒绝；Plugin 只生成 proposal，必须人工审批后才可能部署。

Heartbeat 的锁能防护正常协作进程、路径 traversal 和既有 symlink/junction。v0.1 不防御拥有主机权限的恶意进程在检查与写入间替换 workspace 或祖先 junction；完整 host sandbox 仍是后续工作。
