# Operations

## Setup and data locations

首次安装依赖只执行一次 `pnpm install`。用 `pnpm demo` 进行 credential-free 验收；它使用独立运行目录，不读取 QQ 凭据。正式启动使用 `scripts/init-runtime.ps1`、`scripts/start-runtime.ps1`，并先完成 QQ 配置。

正式运行时：`workspace/SOUL.md` 与 `workspace/AGENT.md` 可由人编辑，bootstrap 只在缺失时创建；`workspace/memory/` 是 Memory Tree，`PROFILE.md` 和 `memory/INDEX.md` 是派生文件；`workspace/.personal-growth/bridge-state.json` 保存 Host 的入站、出站、Memory turn 与序号恢复状态；`workspace/data/` 保存 Heartbeat state；`runtime/` 保存隔离的 DSH home、agents、sessions、storage、Skill 与 Plugin proposal。`workspace/.personal-growth/trace.jsonl` 和 `runtime/extension-trace.jsonl` 只保存经过边界校验和脱敏的元数据。

`runtime/_help-dsh-home/`、临时测试目录和临时文件不是正式运行数据，不能作为备份来源或运行时配置。

## Recovery and pending work

启动和每次受控操作都会恢复可证明的 Memory mutation、Memory turn 与入站租约。遇到结果不确定的 QQ outbound 或 DSH schedule，先停止相关发送、人工确认远端结果，再通过对应的 reconciliation API 标记为“已发送/可重试”；不确定结果不得盲目重发。v0.1 尚未提供面向非技术用户的 reconciliation CLI，这是上线运维前需要保留的人工步骤。备份时应同时保存整个 `workspace/` 与 `runtime/`；两者必须来自同一停机时间点。

Heartbeat 会记录 occurrence，重复 occurrence 在重启后返回 duplicate。时区默认 `Asia/Singapore`，quiet hours 默认 23:00–07:00；普通联系默认 cooldown 120 分钟、每天最多 4 次，高重要度只绕过 cooldown/cap，不绕过 quiet hours。后台 Heartbeat 不拥有 QQ 发送能力。

## Trace and dry-run

Trace 事件是可审计元数据，不包含聊天正文、token、password、secret 或 credential。生产前执行：

```powershell
pnpm verify
.\scripts\verify-isolation.ps1
.\scripts\start-runtime.ps1 -DryRun -LiveQQ -PeerId '<固定用户 Peer ID>'
```

dry-run 输出中的 `cwd` 必须是仓库内 `workspace/`，`DSH_HOME` 与 `DSH_AGENTS_HOME` 必须位于仓库内 `runtime/`。Host 在任何文件写入前还会再次做 canonical path 与 symlink/junction 校验。

## Shutdown and recovery

使用 `Ctrl+C` 或 `SIGTERM` 触发幂等关闭。Host 会停止接收新消息，等待正在处理的回合、Memory 写入和后台任务收束，再关闭 QQ transport。进程被强制终止时，重启会恢复已持久化的入站 payload、Memory turn 和可证明安全的 pending 工作；远端发送结果不确定的 outbound 会保持隔离状态，等待人工 reconciliation。
