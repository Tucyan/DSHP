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

## Model configuration hot update

- The source of truth is `$DSH_HOME/settings.yaml`; this deployment uses `/opt/dshp/runtime/dsh-home/settings.yaml` and the `agent-default-model` namespace.
- Authenticated `GET/PUT /api/model` exposes only provider, model ID, optional reasoning effort, revision, apply mode, and configuration path. API keys remain environment-only.
- PUT uses DSH's locked, atomic, revision-checked settings write. A stale management page receives HTTP 409 instead of overwriting a newer edit.
- A save waits for an in-flight turn to finish, then disposes cached foreground/background Agents. The next request resumes its durable session with the new selection.
- The exact production target for this change is `deepseek-v4.1-flash-expires-on-0910`; its OpenAI-compatible chat completion endpoint returned HTTP 200 in a real API check on 2026-09-09.

## Server verification

Priority hotfix 78d8193: deployed and verified against the real model on 2026-09-08 at 04:27:50Z; background job completed NOOP, service running, QQ ready, zero restarts.

Completion commit `3e73f0465858fa6a125bb71f3517dddd0bc16933` was deployed by Git bundle on 2026-09-08. The bounded server TypeScript build and offline smoke both exited 0; systemd is active with zero restarts. Stopped-service backup: `/opt/dshp-backups/20260908-before-completion-3e73f04.tar.gz`.

The opt-in `scripts/host-live-model-smoke.mjs` passed against the configured real model on the server: three independent facts, Skill creation, public DSH catalog list/get, and reopened memory replay without duplicates. It used synthetic facts in a temporary DSH root and a stub QQ transport; QQ sends were zero. Reopening storage is not a full process-restart delivery test.

Authenticated production background job `verify-completion-3e73f04` completed at `2026-09-08T11:58:21.315Z` (started `11:58:19.979Z`), action `NOOP`, error null. Host lifecycle was running, QQ ready, pending memory/outbound both zero.

## Compatibility and recovery

Existing history/bridge records remain unchanged. New batches use a separate versioned journal. Legacy revisions retain their original evidence format; conflicting legacy histories fail closed rather than being overwritten. Keep pending batch journals with memory, PROFILE/INDEX, revisions and bridge state in the same stopped-service backup.

Rollback should stop the service and preserve current state first. Restore the prior tested code and compatible consistent data; do not discard messages received after backup without operator review. Test facts are confined to temporary roots.

## Remaining live boundary

Real user QQ delivery and scheduled reminder delivery across a service restart require a user-triggered message or explicit authorization to send a test reminder. Automated checks in this task do not send messages to others.
