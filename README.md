# Personal Growth Agent v0.1

一个面向单一固定用户的长期成长 Agent。DSH 提供运行时能力，本仓库提供受控的 Agent Core、长期 Memory、Foreground/Background Heartbeat、QQ/DSH 适配器和本地无凭据验收 Demo。

## 快速体验

```text
pnpm install        # 仅首次安装依赖；不要在运行时重复安装
pnpm demo           # 无凭据，使用临时/隔离运行目录完成完整闭环
pnpm verify         # lint、类型检查、测试、构建
```

正式运行前请阅读 [docs/OPERATIONS.md](docs/OPERATIONS.md) 与 [docs/QQ_SETUP.md](docs/QQ_SETUP.md)。默认数据位于项目 `runtime/` 和 `workspace/`，不会使用用户已有的 `~/.dsh` 或 `~/.agents`。

## v0.1 交付边界

- QQ 单用户接入、跨重启的绑定与主动消息 ledger。
- 对话增量压缩、Dream proposal、Memory Tree 和 PROFILE/INDEX 派生投影。
- 前台联系策略（quiet hours、cooldown、daily cap）和后台隐藏反思。
- Skill 创建需输入/输出/停止条件、正反触发器和版本化验证；Plugin 仅生成待审批 proposal。
- 本地 deterministic Demo 覆盖 QQ → 回复 → Memory → 后台 → 主动联系 → 反馈闭环。

Live QQ 需要用户自行配置凭据；没有凭据时应使用 Demo 或 dry-run，不会读取真实凭据。
