# Runtime Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose and prove the complete long-term feedback loop with restart recovery and auditable outputs.

**Architecture:** The runtime composition root injects stores, clocks, model, QQ, schedules, and side-effect ports. A deterministic demo model drives stable local acceptance scenarios; DSH/QQ live mode uses the same contracts.

**Tech Stack:** TypeScript CLI, Vitest integration tests, PowerShell runtime scripts.

---

### Task 1: Workspace bootstrap and runtime composition

**Files:** Create `workspace/SOUL.md`, `workspace/AGENT.md`, `packages/runtime/src/{bootstrap,runtime,demo-model,cli}.ts`; tests `bootstrap.test.ts`.

- [ ] Write failing tests for idempotent bootstrap, refusal to overwrite human-edited SOUL/AGENT files, and derived PROFILE initialization.
- [ ] Implement the composition root and deterministic demo model.
- [ ] Run runtime tests; expect pass.

### Task 2: Full loop and restart recovery

**Files:** Create `packages/runtime/test/e2e.test.ts`, `restart.test.ts`, `hidden-session.test.ts`.

- [ ] Write a failing end-to-end test: QQ message, response, consolidation, background Dream, memory/profile update, foreground proactive message, user feedback.
- [ ] Write failing restart tests for memory cursor, QQ binding, heartbeat occurrence dedupe, and schedule bindings.
- [ ] Write a failing test proving background records never appear in the main conversation query.
- [ ] Implement only the glue required to make these tests pass.
- [ ] Re-run integration and all package tests; expect pass.

### Task 3: Self-extension and documentation

**Files:** Create `packages/runtime/src/extension-writer.ts`, `docs/{OPERATIONS,QQ_SETUP,DATA_MODEL,SECURITY}.md`; tests `extension-writer.test.ts`.

- [ ] Write failing tests for traversal-safe Skill creation in isolated Agents home and append-only Plugin Proposal generation in workspace data.
- [ ] Implement validation, versioned filenames, and trace records; do not install or activate proposals.
- [ ] Document exact setup, credential references, local demo, live smoke, backup, recovery, and limitations.
- [ ] Run `pnpm verify`; expect tests, coverage thresholds, lint, typecheck, and build all pass.
- [ ] Commit `feat: complete personal growth agent v0.1 loop`.

