# Task Plan: Personal Growth Agent v0.1

## Goal

Build and verify a single-user Personal Growth Agent v0.1 on an isolated DSH instance, with durable semantic memory, foreground/background heartbeat, schedules, QQ messaging, self-extension proposals, and traceability.

## Current Phase

Phase 6

## Phases

### Phase 1: Requirements, DSH Baseline, and Architecture

- [x] Capture user requirements and attached implementation guidance
- [x] Inspect the workspace and local toolchain
- [x] Verify current DSH APIs and QQ integration options from primary sources
- [x] Lock the DSH version/commit and document the baseline
- [x] Produce executable subsystem plans and shared contracts
- **Status:** complete

### Phase 2: Repository and Isolated Runtime Foundation

- [x] Initialize the TypeScript monorepo and feature branch
- [x] Add isolated DSH launcher/configuration without modifying `~/.dsh` or `~/.agents`
- [x] Add shared contracts, configuration, test harness, and trace schema
- [x] Verify the isolated baseline
- **Status:** complete

### Phase 3: Core, Memory, and Heartbeat Plugins

- [x] Implement `personal-agent-core` using TDD
- [x] Implement `personal-memory` using TDD
- [x] Implement `personal-heartbeat` using TDD
- [x] Run spec-compliance and code-quality reviews after every implementation task
- **Status:** complete

### Phase 4: Schedule and QQ Adapters

- [x] Integrate DSH Schedule through an adapter and durable bindings
- [x] Integrate a single-user QQ text channel and proactive send path
- [x] Provide local fake adapters when external credentials/services are unavailable
- [x] Verify restart persistence and authorization boundaries
- **Status:** complete

### Phase 5: End-to-End Autonomous Loop

- [x] Connect conversation consolidation, Dream proposals, memory writes, and profile rebuilding
- [x] Connect background maintenance and foreground contact decisions
- [x] Connect schedule and QQ proactive messaging
- [x] Add Skill creation and Plugin proposal workflows with approval boundaries
- [x] Add trace queries and hidden-background-session behavior
- **Status:** complete

### Phase 6: Verification, Documentation, and Handoff

- [x] Run full unit, integration, build, lint, and isolation checks
- [x] Run final subagent review against every v0.1 success criterion
- [x] Document configuration, credentials, operations, recovery, and known limitations
- [ ] Present branch integration options
- **Status:** in_progress

## Key Questions

1. Which exact DSH release/commit and plugin APIs are stable enough to pin?
2. Is there a maintained QQ channel plugin compatible with the pinned DSH version?
3. Which behaviors can be verified locally without QQ credentials or a live DSH model provider?
4. How should background sessions be represented so that DSH UI visibility and internal persistence remain separate?

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Use a TypeScript pnpm monorepo | DSH is a TypeScript/pnpm project and plugin adapters can share its native ecosystem |
| Keep DSH behind explicit adapter ports | DSH is Developer Preview and can introduce breaking changes |
| Build deterministic local fakes for DSH, QQ, schedules, and the model | Enables complete automated tests without external credentials or network services |
| Treat Memory Tree as the only semantic truth | Matches the requested memory boundary; PROFILE and INDEX remain derived caches |
| Keep operational events outside semantic memory | Prevents recomputable telemetry and transient facts from polluting long-term memory |
| Use a feature branch in the new repository | Satisfies isolated implementation workflow without modifying an existing branch |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| Workspace was not a Git repository | 1 | Treat as a greenfield project; initialize a repository and feature branch before production code |
| Initial combined skill read was truncated | 1 | Re-read each required skill file in smaller complete groups |
| Offline dependency refresh was blocked by ignored native build scripts | 1 | Did not retry installation; used the existing workspace toolchain and synchronized only the required lock importer |
| Final narrow subagent rechecks hit the shared usage limit | 1 | Retained prior independent findings and completed the narrow code inspection plus fresh root verification locally |

## Notes

- Long-running installs/downloads may be attempted only once. If they time out, hand them to the user.
- Do not modify the user's existing `~/.dsh` or `~/.agents` directories.
- External credentials are never committed; live QQ/DSH verification is conditional on credentials.
- NOOP is a first-class foreground heartbeat result; background heartbeat must never directly message the user.
