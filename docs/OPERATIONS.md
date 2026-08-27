# Operations

## Setup and data locations

首次安装依赖只执行一次 `pnpm install`。用 `pnpm demo` 进行 credential-free 验收；它使用独立运行目录，不读取 QQ 凭据。正式启动使用现有 `scripts/init-runtime.ps1`、`scripts/start-runtime.ps1`，并先完成 QQ 配置。

正式运行时：`workspace/SOUL.md` 与 `workspace/AGENT.md` 可由人编辑，bootstrap 只在缺失时创建；`workspace/memory/` 是 Memory Tree，`PROFILE.md` 和 `memory/INDEX.md` 是派生文件；`runtime/storage/` 保存 cursor、QQ binding、schedule；`workspace/data/` 保存 Heartbeat state；`runtime/sessions/background/` 保存隐藏维护记录；trace 只保存脱敏元数据。

`runtime/_help-dsh-home/`、临时测试目录和临时文件不是正式运行数据，不能作为备份来源或运行时配置。

## Recovery and pending work

启动和每次受控操作都会恢复可证明的 Memory pending mutation。遇到 pending QQ outbound 或 DSH schedule，先人工确认远端结果，再调用对应 reconcile；不确定结果不得自动重试以免重复消息或任务。备份时同时保存 `workspace/` 与 `runtime/storage/`，恢复后运行 `pnpm demo` 或完整测试。

Heartbeat 会记录 occurrence，重复 occurrence 在重启后返回 duplicate。quiet hours 默认 00:00–08:00；普通联系默认 cooldown 120 分钟、每天最多 4 次，高重要度只绕过 cooldown/cap，不绕过 quiet hours。

## Trace and dry-run

`traces.jsonl` 的事件是可审计元数据，不包含正文、token、password、secret 或 credential。生产前建议执行 `pnpm verify`、`scripts/verify-isolation.ps1`，再以 dry-run 验证路径和 QQ 单用户 gate。
