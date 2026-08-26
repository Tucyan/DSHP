# DSH Schedule and QQ Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect DSH schedules and Tencent QQ to the same single-user runtime boundary with credential-free local fakes.

**Architecture:** `DshSchedulePort` represents session-local reminders. `QqPort` represents inbound authorization and outbound messages. Deployment scripts install exact external bundles; domain tests use in-memory adapters.

**Tech Stack:** TypeScript, Vitest, DSH 0.1.1-rc.2, `@tencent-connect/dsh-qqbot` 0.4.0, PowerShell.

---

### Task 1: Schedule adapter

**Files:** Create `packages/dsh-adapter/src/{schedule,paths}.ts`; tests `schedule.test.ts`, `paths.test.ts`.

- [ ] Write failing contract tests for one-time create, periodic create >=300 seconds, list, delete, user session binding, and normalized errors.
- [ ] Write a failing isolation test that rejects default home paths and paths outside the repository runtime root.
- [ ] Implement interfaces plus local fake; keep DSH tool invocation in a narrow live adapter.
- [ ] Run adapter tests; expect pass.

### Task 2: QQ single-user and proactive messaging adapter

**Files:** Create `packages/qq-adapter/src/{config,gate,port,fake}.ts`; tests `gate.test.ts`, `fake.test.ts`.

- [ ] Write failing tests that accept exactly one configured peer, reject groups and all other peers, persist the deterministic binding, and send proactive text only to that peer.
- [ ] Implement validated environment/config parsing and secret redaction; never persist AppSecret.
- [ ] Implement fake inbound/outbound queues for end-to-end tests.
- [ ] Run QQ tests; expect pass.

### Task 3: Isolated DSH profile scripts

**Files:** Create `scripts/{init-runtime,start,verify-isolation}.ps1`, `.env.example`, and `runtime/README.md`; test `tests/scripts/isolation.test.ts`.

- [ ] Write a failing process-level test that captures computed env/cwd/arguments without launching DSH.
- [ ] Implement scripts using resolved literal paths, exact package versions, port validation, and dry-run mode.
- [ ] Add opt-in command to install the exact custom bundles and Tencent QQ bundle into the isolated profile.
- [ ] Run script tests; expect no access to the default `.dsh` or `.agents` roots.
- [ ] Commit `feat: add isolated DSH schedule and QQ adapters`.

