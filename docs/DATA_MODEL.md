# Data model

| 数据 | 所有者 | 说明 |
| --- | --- | --- |
| `memory/preferences|contexts|decisions|events/*.md` | MemoryService | 长期语义真源，所有变更来自受控 proposal |
| `memory/history.jsonl` | MemoryService/Consolidator | 压缩后的经历和 source refs，不是最终画像 |
| `PROFILE.md`, `memory/INDEX.md` | MemoryService | 从 Memory Tree 自动派生，禁止手工作为语义真源 |
| `workspace/data/heartbeat-state.json` | HeartbeatLedger | occurrence、联系 reservation 和 contact policy 状态 |
| `workspace/.personal-growth/bridge-state.json` | DSH Host Bridge | Live QQ inbound/outbound、Memory turn、sequence 与恢复租约 |
| `runtime/storage/qq-binding.json` | DurableQqPort | 本地 Runtime/Demo 的固定 peer、durable inbox/outbox ledger |
| `runtime/storage/schedules.json` | DshSchedule | 本地 Runtime/Demo 的 schedule 绑定、pending/overdue 状态 |
| `runtime/dsh-home/`, `runtime/agents-home/` | DSH Host | 独立 DSH profile、Session 与受控 Skill；不使用用户默认 home |
| `runtime/plugin-proposals/` | ExtensionWriter | append-only 待审批设计，不安装/激活 |
| `workspace/.personal-growth/trace.jsonl` | DSH Host | Live Host 严格 schema 的脱敏操作 trace |
| `runtime/extension-trace.jsonl` | ExtensionWriter | Skill/Plugin proposal 写入的独立脱敏 trace |

能从行为数据重新计算的统计不写入 Memory。Memory 读写、proposal、heartbeat、QQ outbound 和 extension 都应产生可脱敏追踪。
