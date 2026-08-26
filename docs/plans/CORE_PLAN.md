# Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement one context and action boundary used by user messages, schedules, and both heartbeat modes.

**Architecture:** `ContextBuilder` reads explicit ports and produces a bounded context. `AgentCore` asks a model port for a structured action, validates it, applies trigger policy, traces the decision, and delegates side effects through ports.

**Tech Stack:** TypeScript, Zod, Vitest, Cordis service entry point.

---

### Task 1: Context builder

**Files:** Create `packages/agent-core/src/context-builder.ts`; test `packages/agent-core/test/context-builder.test.ts`.

- [ ] Write a failing test asserting ordered SOUL, mission, PROFILE, relevant memories, current goal, session delta, and trigger fields, with byte limits.
- [ ] Run the single test; expect module-not-found or missing export failure.
- [ ] Implement `buildContext(input: ContextInput): AgentContext` with deterministic truncation of low-priority sections first.
- [ ] Re-run the test; expect pass.
- [ ] Commit with the remaining Core task after refactor.

### Task 2: Trigger-aware action policy

**Files:** Create `packages/agent-core/src/action-policy.ts`; test `packages/agent-core/test/action-policy.test.ts`.

- [ ] Write failing tests: user message may RESPOND; foreground may MESSAGE_USER/NOOP; background may NOOP/REFLECT/CREATE_SKILL/PROPOSE_PLUGIN and rejects user-visible actions.
- [ ] Run the test and verify the expected missing implementation failure.
- [ ] Implement `assertActionAllowed(trigger, action)` returning a validated action or typed `PolicyViolation`.
- [ ] Run all Core tests; expect pass.

### Task 3: Core orchestration and extension outputs

**Files:** Create `packages/agent-core/src/service.ts`, `capability.ts`, `plugin.ts`, `index.ts`, `cordis.patch.yml`, and package manifest; test `service.test.ts`.

- [ ] Write failing tests for model action validation, NOOP, response delivery, Skill draft creation, Plugin proposal creation, and trace emission.
- [ ] Run Core tests and confirm RED.
- [ ] Implement injected ports and `AgentCore.handle(trigger)` without direct filesystem/network calls.
- [ ] Add Cordis class-form service named `personalAgentCore` and an installable DSH bundle row.
- [ ] Run Core tests, package build, and typecheck; expect zero failures.
- [ ] Commit `feat: add trigger-aware personal agent core`.

