# Personal Growth Agent v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a runnable, restart-safe, single-user Personal Growth Agent v0.1 composed with DSH and QQ.

**Architecture:** Domain logic lives in small TypeScript packages behind ports. DSH and Tencent QQ are pinned deployment adapters; deterministic local adapters prove the complete behavior without credentials.

**Tech Stack:** Node 24, TypeScript 5, pnpm, Vitest, Zod, Cordis/DSH 0.1.1-rc.2, Tencent QQ bundle 0.4.0.

---

### Task 1: Foundation and shared contracts

**Files:** Create root manifests/config; create `packages/shared/src/{contracts,config,storage,trace}.ts`; test under `packages/shared/test/`.

- [ ] Write tests for trigger/action schemas, background action rejection, atomic JSON, JSONL append/read, and redaction.
- [ ] Run `pnpm --filter @personal-growth/shared test` and verify failures are caused by missing modules.
- [ ] Implement the minimal shared contracts and storage utilities.
- [ ] Re-run the package tests and `pnpm typecheck`; expect zero failures.
- [ ] Commit `feat: add shared personal agent contracts`.

The frozen public API is:

```ts
type AgentTrigger =
  | { type: 'user_message'; sessionId: string; text: string; at: string }
  | { type: 'foreground_heartbeat'; occurrenceId: string; at: string }
  | { type: 'background_heartbeat'; occurrenceId: string; at: string }
  | { type: 'schedule'; scheduleId: string; prompt: string; at: string }
  | { type: 'system'; reason: string; at: string }

type AgentAction =
  | { type: 'NOOP'; reason: string }
  | { type: 'RESPOND'; text: string }
  | { type: 'MESSAGE_USER'; text: string; importance: 'low' | 'normal' | 'high' }
  | { type: 'CREATE_SKILL'; name: string; instructions: string }
  | { type: 'PROPOSE_PLUGIN'; name: string; capabilityGap: string; design: string }
  | { type: 'REFLECT'; summary: string }
```

### Task 2: Agent Core

Follow `CORE_PLAN.md`. Complete RED/GREEN cycles, Cordis bundle packaging, spec review, quality review, and commit.

### Task 3: Personal Memory

Follow `MEMORY_PLAN.md`. The eight required memory cases and crash-safe projections are release gates.

### Task 4: Personal Heartbeat

Follow `HEARTBEAT_PLAN.md`. Background messaging prohibition and occurrence idempotency are release gates.

### Task 5: DSH Schedule and QQ adapters

Follow `QQ_PLAN.md`. Keep DSH `0.1.1-rc.2` and Tencent QQ `0.4.0` exact in the lockfile/config.

### Task 6: End-to-end runtime

Follow `INTEGRATION_PLAN.md`. Run the local loop, restart recovery, isolation check, build, and optional live smoke instructions.

### Task 7: Final review and branch handoff

- [ ] Dispatch a fresh final reviewer with the full v0.1 criteria and current diff.
- [ ] Resolve every Critical or Important finding, then re-review.
- [ ] Run `pnpm verify` fresh and record exact counts in `progress.md`.
- [ ] Present merge, PR, keep, and discard options without performing a destructive choice automatically.

