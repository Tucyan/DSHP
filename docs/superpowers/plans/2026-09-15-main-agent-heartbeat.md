# Main agent heartbeat and delivery reliability Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent prompt management task, and sequential integration for shared runtime changes.

**Goal:** Wake the main agent periodically, ensure user requests receive delivery or an explicit failure, and hot-load editable heartbeat prompts.

**Architecture:** Serialize user and heartbeat execution in PersonalGrowthBridge. Persist heartbeat claims independently of contact admission; check contact policy only when sending. Add bounded user delivery repair without forwarding arbitrary assistant output. PromptStore migrates old documents and captures prompt text once per wake.

**Tech Stack:** TypeScript, Cordis/DSH, Zod, React, Vitest, pnpm, systemd.

## Tasks

- [x] Add failing bridge tests: user plain text triggers one correction; repeated omission yields a fixed fallback; unknown delivery never retries; successful delivery avoids duplicate final; quiet heartbeat runs same agent and may end silently; busy wakes coalesce and serialize.
- [x] Implement Bridge foreground runner, active execution provenance and delivery state. Correction uses `followup({source:'delivery-repair', text: DELIVERY_REPAIR_PROMPT})`; fallback uses a stable outbound key and fixed public text. Keep source strings outside user-message history.
- [x] Add failing durable foreground-runner tests: duplicate occurrence after reopen, silent work in quiet hours, denied sending, confirmed contact and unknown transport reservation. Implement against HeartbeatLedger with short hashed occurrence IDs.
- [x] Implement editable `foregroundHeartbeat`/`backgroundHeartbeat` documents with defaults, old state migration, optimistic hashes, audit and next-wake snapshots. Add UI editors and storage/API regression tests.
- [x] Wire production foreground runner and background prompt snapshot in plugin.ts. Keep official Schedule policy delivery separate; preserve tools, source-aware memory, stable outbox IDs and hidden-agent restrictions.
- [x] Run focused tests via `corepack pnpm@11.7.0 exec vitest run ... --maxWorkers=1`, then full `corepack pnpm@11.7.0 verify`. Investigate any failure before changing assertions.
- [x] Perform spec and quality review, fix findings, update operator docs. Commit and push existing feature branch without rewriting history.
- [x] Create verified Git bundle, inspect production status, back up stopped-service state, fast-forward, bounded 768MB TypeScript and admin build, start service. Verify SHA, authenticated readiness, private listener, queues, and unchanged Nginx. No server test suite. Limit optional live model requests to two, counting failures.
