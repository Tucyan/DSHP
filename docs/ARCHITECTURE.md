# Personal Growth Agent v0.1 Architecture

## Runtime flow

```text
QQ Host Bridge / local demo / DSH schedule / heartbeat worker
                    |
                    v
             AgentRuntime.handle(trigger)
                    |
                    v
       ContextBuilder + ActionPolicy + ModelPort
          |             |             |
          v             v             v
       MemoryPort    TraceStore    Skill/Plugin proposals
          |
          v
history.jsonl -> DreamProposal -> MemoryService -> Memory Tree
                                             |-> INDEX.md
                                             `-> PROFILE.md
```

本地 deterministic Demo 的 wake paths 使用 `AgentRuntime` composition root；正式 QQ 由 `@personal-growth/dsh-host` 组合 DSH public Agent/Session/Schedule API、腾讯 QQBot、Memory 与 Heartbeat。两条 composition 共用相同的 domain services、策略和持久化边界，但正式 Host 不依赖 QQ bundle 私有 API。

## Package boundaries

- `@personal-growth/shared`: schemas, trigger/action/event contracts, result types, atomic JSON/JSONL helpers, trace records.
- `@personal-growth/agent-core`: context assembly, action validation, trigger policy, capability-gap routing, Cordis service entry.
- `@personal-growth/personal-memory`: cursor-based consolidation, proposal validation, Memory Tree mutation, revision ledger, INDEX/PROFILE projections.
- `@personal-growth/personal-heartbeat`: quiet hours, cooldown, daily cap, occurrence idempotency, foreground/background dispatch.
- `@personal-growth/dsh-adapter`: isolated paths, DSH launch arguments, session/schedule interfaces, bundle/profile helpers.
- `@personal-growth/qq-adapter`: single-user gate and durable inbox/outbox port used by the local Runtime; production Host uses the same single-user invariants with Tencent QQBot WebSocket.
- `@personal-growth/runtime`: composition root, local deterministic model, end-to-end demo, operational state.
- `@personal-growth/dsh-host`: production DSH/QQ composition, hidden agents, durable bridge state, session-event Memory pipeline, proactive policy gate.

## Storage ownership

```text
workspace/
  SOUL.md                         stable agent identity, human-editable
  AGENT.md                        mission and stage configuration
  PROFILE.md                      derived cache; never hand-edited by runtime
  memory/
    INDEX.md                      derived navigation
    history.jsonl                compressed experience deltas
    state.json                   consolidation cursors and projection metadata
    revisions.jsonl              append-only semantic revision audit
    preferences/*.md             semantic truth
    contexts/*.md                semantic truth
    decisions/*.md               semantic truth
    events/*.md                  rare durable milestones
    archive/*.md                 archived semantic truth
  data/
    heartbeat-state.json         operational contact/occurrence state
    traces.jsonl                 operational trace ledger
  .personal-growth/
    bridge-state.json            live inbound/outbound, memory turns, leases and sequence state
    trace.jsonl                  live host redacted trace
runtime/
  dsh-home/                      isolated DSH profile and configuration
  agents-home/                   isolated DSH agents and versioned Skills
  storage/
    qq-binding.json              local Runtime/Demo durable inbox/outbox
    schedules.json               local Runtime/Demo schedule bindings
  sessions/background/*.jsonl    hidden maintenance records
  plugin-proposals/*.md          reviewable extension proposals (append-only; pending approval)
  extension-trace.jsonl          separate extension-writer audit
```

## Safety invariants

1. Only `MemoryService` mutates the Memory Tree, INDEX, PROFILE, revisions, or cursor state.
2. Dream outputs proposals and has no filesystem capability.
3. `background_heartbeat` rejects `RESPOND` and `MESSAGE_USER` actions.
4. QQ inbound traffic is accepted only from the configured fixed peer.
5. Every proactive message requires a passed contact policy and a deduplicated occurrence key.
6. Skills may be created in the isolated Agents home; plugin code remains a proposal pending human deployment approval.
7. Credentials are environment references and never enter traces, memory, or committed files.
8. Live inbound completion occurs only after its durable Memory turn succeeds; a failed turn remains recoverable.
9. Foreground proactive output is sent only after Heartbeat policy admission; ordinary QQ replies must belong to the currently active authorized inbound message.

## Heartbeat v0.1 trust boundary

Heartbeat storage protects against accidental path traversal, pre-existing symlink/junction workspace components, and normal cross-process contention between cooperating workers. It does not defend against a process with host permissions that maliciously replaces the workspace or an ancestor symlink/junction during a check/write window. Full host sandbox isolation is out of scope for v0.1.
