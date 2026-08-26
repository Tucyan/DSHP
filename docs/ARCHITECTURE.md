# Personal Growth Agent v0.1 Architecture

## Runtime flow

```text
QQ / local demo / DSH schedule / heartbeat worker
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

All wake paths use the same `AgentRuntime` entry point. Domain packages do not import DSH, QQ, or wall-clock globals; adapters supply those ports.

## Package boundaries

- `@personal-growth/shared`: schemas, trigger/action/event contracts, result types, atomic JSON/JSONL helpers, trace records.
- `@personal-growth/agent-core`: context assembly, action validation, trigger policy, capability-gap routing, Cordis service entry.
- `@personal-growth/personal-memory`: cursor-based consolidation, proposal validation, Memory Tree mutation, revision ledger, INDEX/PROFILE projections.
- `@personal-growth/personal-heartbeat`: quiet hours, cooldown, daily cap, occurrence idempotency, foreground/background dispatch.
- `@personal-growth/dsh-adapter`: isolated paths, DSH launch arguments, session/schedule interfaces, bundle/profile helpers.
- `@personal-growth/qq-adapter`: single-user gate and proactive-send port; real deployment composes Tencent's QQ bundle.
- `@personal-growth/runtime`: composition root, local deterministic model, end-to-end demo, operational state.

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
    qq-binding.json              fixed authorized peer and session binding
    traces.jsonl                 operational trace ledger
    plugin-proposals/*.md         reviewable extension proposals
  sessions/background/*.jsonl    hidden maintenance records
```

## Safety invariants

1. Only `MemoryService` mutates the Memory Tree, INDEX, PROFILE, revisions, or cursor state.
2. Dream outputs proposals and has no filesystem capability.
3. `background_heartbeat` rejects `RESPOND` and `MESSAGE_USER` actions.
4. QQ inbound traffic is accepted only from the configured fixed peer.
5. Every proactive message requires a passed contact policy and a deduplicated occurrence key.
6. Skills may be created in the isolated Agents home; plugin code remains a proposal pending human deployment approval.
7. Credentials are environment references and never enter traces, memory, or committed files.

## Heartbeat v0.1 trust boundary

Heartbeat storage protects against accidental path traversal, pre-existing symlink/junction workspace components, and normal cross-process contention between cooperating workers. It does not defend against a process with host permissions that maliciously replaces the workspace or an ancestor symlink/junction during a check/write window. Full host sandbox isolation is out of scope for v0.1.
