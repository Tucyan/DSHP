# Personal Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wake the agent safely for proactive foreground contact and hidden background maintenance.

**Architecture:** A pure contact policy decides eligibility. A durable occurrence ledger prevents duplicate dispatch across restarts. The service calls Agent Core with an explicit trigger and stores hidden background transcripts separately.

**Tech Stack:** TypeScript, Zod, Vitest fake clock, atomic JSON state.

---

### Task 1: Foreground contact policy

**Files:** Create `packages/personal-heartbeat/src/contact-policy.ts`; test `contact-policy.test.ts`.

- [ ] Write failing timezone-aware tests for quiet hours across midnight, cooldown, maximum contacts per local day, importance override behavior, and normal NOOP.
- [ ] Run the focused test; confirm RED.
- [ ] Implement `evaluateContactPolicy(config, state, candidate, now)` as a pure function.
- [ ] Re-run the test; expect pass.

### Task 2: Durable heartbeat dispatch

**Files:** Create `ledger.ts`, `service.ts`, `plugin.ts`, `index.ts`, `cordis.patch.yml`; tests `service.test.ts`, `restart.test.ts`.

- [ ] Write failing tests for occurrence dedupe, foreground MESSAGE_USER, foreground NOOP, background reflection, background Dream trigger, and hard rejection of background messages.
- [ ] Run tests; confirm RED.
- [ ] Implement serialized ledger admission, Agent Core dispatch, post-action state recording, hidden session sink, and Cordis service `personalHeartbeat`.
- [ ] Re-run tests after reconstructing services from the same temp directory; expect no duplicate actions.
- [ ] Commit `feat: add foreground and background heartbeat`.

