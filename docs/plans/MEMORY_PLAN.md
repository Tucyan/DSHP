# Personal Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a controlled, auditable semantic Memory Tree with incremental conversation consolidation and derived PROFILE/INDEX caches.

**Architecture:** The Consolidator consumes only unseen conversation sequence numbers into compressed history. Dream is a pure proposal generator. MemoryService validates and atomically applies proposals, appends revisions, then rebuilds projections.

**Tech Stack:** TypeScript, Zod, Markdown/JSON/JSONL files, Vitest temporary directories.

---

### Task 1: Read APIs and cursor consolidation

**Files:** Create `packages/personal-memory/src/{paths,reader,consolidator}.ts`; tests `reader.test.ts`, `consolidator.test.ts`.

- [ ] Write failing tests for `list`, `search`, `read`, and cursor consumption of sequences 1-10 then only 11-15.
- [ ] Run Memory tests; confirm RED because APIs are absent.
- [ ] Implement traversal-safe reads, compressed history append, and atomic `state.json` cursor advancement after history persistence.
- [ ] Re-run tests; expect pass including replay after service reconstruction.

### Task 2: Proposal validation and Memory Tree writes

**Files:** Create `proposal.ts`, `service.ts`, `revision.ts`; test `service.test.ts`.

- [ ] Write failing tests for CREATE, UPDATE, MERGE, ARCHIVE, IGNORE, invalid paths, source evidence, before/after hashes, and explicit remember.
- [ ] Run the focused tests and confirm RED.
- [ ] Implement a closed Zod proposal union and serialized MemoryService transaction queue with atomic file replacement.
- [ ] Ensure Dream accepts data and returns proposals only; it receives no filesystem port.
- [ ] Re-run tests; expect pass.

### Task 3: INDEX and PROFILE projections

**Files:** Create `profile-builder.ts`, `index-builder.ts`, `plugin.ts`, `index.ts`, `cordis.patch.yml`; tests `projections.test.ts`, `acceptance.test.ts`.

- [ ] Write failing acceptance cases: stable preference CREATE; existing preference UPDATE; duplicate IGNORE; conflict UPDATE with evidence; temporary IGNORE; recomputable statistic IGNORE; explicit remember immediate write; cursor no-repeat.
- [ ] Run acceptance tests; confirm RED.
- [ ] Implement deterministic Markdown projections from active Memory Tree entries and expose `personalMemory` Cordis service.
- [ ] Re-run Memory tests and build; expect all eight cases pass.
- [ ] Commit `feat: add controlled semantic memory service`.

