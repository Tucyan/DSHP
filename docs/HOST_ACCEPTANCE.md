# Host completion acceptance

## Changes

- Hidden actions carry complete role-specific JSON examples, one bounded format correction, safe error codes and read-only tool guards. The 2026-09-07 failure was a successful model turn returning `{"action":"NOOP"}` rather than the required `type` and `reason` fields.
- Foreground/background Skill creation shares validated draft construction; supplied foreground descriptions are retained when valid.
- Foreground decisions read the fixed session's Goal, persisted recent human conversation, active schedules, identity, memory and contact ledger. Missing sources produce NOOP. The serialized snapshot is capped at 12 KiB.
- Dream accepts up to eight disjoint proposals per history. Frozen batches are stored in `workspace/.personal-growth/dream-batches/`; each memory mutation remains atomic and idempotent. A crash after mutation but before batch acknowledgement replays the exact proposal. The batch itself is recoverable, not an all-or-nothing multi-file transaction.
- A maintenance pass handles at most ten pending histories, refreshes projections between histories, and reports failure while allowing other independent histories to progress.

## Local verification

2026-09-08: lint/typecheck passed; full serial Vitest run passed 67 files / 330 tests. Default parallel execution had resource-sensitive failures in existing 10,000-entry inbox fixtures; serial execution retains all assertions and passes.

```sh
pnpm lint
pnpm typecheck
pnpm exec vitest run --maxWorkers=1
pnpm build
node scripts/host-offline-smoke.mjs
```

Offline smoke creates and removes a temporary root. It exercises actual MemoryService and ExtensionWriter, crash replay, bounded action correction, complete context, and the locked DSH FileSystemSkillProvider list/get APIs. It does not read production credentials or data.

## Server verification

Priority hotfix 78d8193: deployed and verified against the real model on 2026-09-08 at 04:27:50Z; background job completed NOOP, service running, QQ ready, zero restarts.

The additional completion changes require deployment evidence below before claiming live completion. The opt-in `scripts/host-live-model-smoke.mjs` uses only synthetic facts in a temporary DSH root and a stub QQ transport that rejects sends. It calls the configured real model for three facts and a Skill proposal, loads the generated skill through public DSH APIs and verifies memory replay. It is not evidence of a user receiving a QQ message.

## Compatibility and recovery

Existing history/bridge records remain unchanged. New batches use a separate versioned journal. Legacy revisions retain their original evidence format; conflicting legacy histories fail closed rather than being overwritten. Keep pending batch journals with memory, PROFILE/INDEX, revisions and bridge state in the same stopped-service backup.

Rollback should stop the service and preserve current state first. Restore the prior tested code and compatible consistent data; do not discard messages received after backup without operator review. Test facts are confined to temporary roots.

## Remaining live boundary

Real user QQ delivery and scheduled reminder delivery across a service restart require a user-triggered message or explicit authorization to send a test reminder. Automated checks in this task do not send messages to others.
