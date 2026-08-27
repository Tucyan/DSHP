# Data model

| 数据 | 所有者 | 说明 |
| --- | --- | --- |
| `memory/preferences|contexts|decisions|events/*.md` | MemoryService | 长期语义真源，所有变更来自受控 proposal |
| `memory/history.jsonl` | MemoryService/Consolidator | 压缩后的经历和 source refs，不是最终画像 |
| `PROFILE.md`, `memory/INDEX.md` | MemoryService | 从 Memory Tree 自动派生，禁止手工作为语义真源 |
| `workspace/data/heartbeat-state.json` | HeartbeatLedger | occurrence、联系 reservation 和 contact policy 状态 |
| `runtime/storage/qq-binding.json` | DurableQqPort | 固定 peer、outbound pending/sent ledger |
| `runtime/storage/schedules.json` | DshSchedule | DSH schedule 本地绑定、pending/overdue 状态 |
| `runtime/sessions/main/` | Runtime | 用户可见主会话；`background/` 永不进入主查询 |
| `runtime/plugin-proposals/` | ExtensionWriter | append-only 待审批设计，不安装/激活 |

能从行为数据重新计算的统计不写入 Memory。Memory 读写、proposal、heartbeat、QQ outbound 和 extension 都应产生可脱敏追踪。
