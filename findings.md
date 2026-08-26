# Findings & Decisions

## Requirements

- One agent serves one fixed user over a long period.
- DSH supplies runtime primitives; custom business behavior lives in plugins and skills.
- Implement `personal-agent-core`, `personal-memory`, and `personal-heartbeat`.
- Reuse DSH Schedule and a compatible QQ channel when available.
- Preserve a strict semantic-memory/operational-data boundary.
- Memory writes must pass through proposals and a controlled service.
- Separate foreground contact decisions from hidden background maintenance.
- Support autonomous Skill creation and Plugin proposal generation, but do not auto-deploy new plugins in v0.1.
- Isolate DSH home, agents home, workspace, plugins, skills, sessions, storage, credentials, and web port.
- Provide traceability for critical decisions and actions.

## Research Findings

- The supplied implementation note recommends: shared baseline, three custom plugins, two integrations, then end-to-end integration.
- The workspace was empty and contained no existing Git history or project files.
- Local toolchain: Node v24.11.1, Corepack 0.34.2, pnpm 10.28.2, npm 11.6.2, Git 2.41.0.windows.1.
- DSH is described as Developer Preview in the supplied note; exact current APIs and version still require primary-source verification.
- On 2026-08-26, npm reports `@deepseek-ai/dsh` `latest` and `next` as `0.1.1-rc.2`, last modified 2026-08-21.
- The DSH upstream `master` HEAD observed on 2026-08-26 is `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.
- Official app-boot docs define a profile under `$DSH_HOME/profiles/<name>` with a package manifest and ordered bundle layers; out-of-tree bundles declare `dsh.bundle.patch`.
- Official skill-filesystem docs confirm `$DSH_HOME` defaults to `~/.dsh` and `$DSH_AGENTS_HOME` defaults to `~/.agents`; isolated skill discovery can disable default roots.
- The in-box `@deepseek-ai/dsh-schedule` exposes `schedule_create`, `schedule_list`, and `schedule_delete`, persists inside the current Session, and supports delay, absolute time, and fixed intervals of at least 300 seconds.
- Tencent maintains `@tencent-connect/dsh-qqbot`; current repository manifest version is `0.4.0`, with deterministic QQ peer-to-DSH Session mapping and restart recovery.
- Tencent's QQ plugin supports QR binding or `QQBOT_APPID`/`QQBOT_SECRET`, direct/group prompts, agent preset selection, and assistant-output forwarding to QQ.
- The QQ plugin peer-depends on DSH agent/session/LLM packages `>=0.1.0-rc.6`, so it is compatible in principle with pinned DSH `0.1.1-rc.2`; live compatibility still needs a smoke test.
- For the single-user requirement, the project must add an explicit fixed-user gate around inbound handling/configuration because the upstream plugin supports multiple peers by default.
- Reconnaissance subagent confirmed DSH `0.1.1-rc.2` requires Node `^22.19.0 || >=24.0.0` and the upstream repository declares pnpm `11.7.0`; the local Node 24 satisfies the runtime requirement.
- DSH Session is an append-only event source with JSONL/SQLite persistence and interrupted-turn recovery; durable Goal mutations are Session events using revision compare-and-set.
- DSH Schedule only fires while its owning Session is live; cold-session reminders become overdue after resume, and delivery is best-effort at-least-once.
- `DSH_AGENTS_HOME` is primarily a shared skill-discovery root, not a second Session/Goal persistence root.
- Official plugin guidance supports TypeScript modules exporting `apply(ctx)` and class-form Cordis `Service` providers; external bundles use a `cordis.patch.yml` layer.

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Hexagonal ports around DSH, model, schedule, QQ, clock, and filesystem | Keeps domain logic deterministic and protects the project from DSH breaking changes |
| JSON/JSONL + Markdown storage with atomic writes | Human-auditable, restart-safe, and appropriate for a single-user v0.1 |
| Zod schemas at all persistence and adapter boundaries | Makes proposals and configuration fail closed |
| Vitest with real temporary directories | Tests actual persistence behavior rather than mocks |
| Background action allow-list | Structurally forbids `MESSAGE_USER` during hidden maintenance runs |
| Pin `@deepseek-ai/dsh` to `0.1.1-rc.2` and record upstream commit separately | Avoids following a moving prerelease while preserving the source baseline used for API review |
| Separate session reminders from deployment heartbeat scheduling | Official DSH Schedule is session-local; background autonomy needs a durable deployment-level wake mechanism |
| Integrate Tencent `@tencent-connect/dsh-qqbot@0.4.0` instead of developing a QQ protocol stack | It is purpose-built for DSH, uses deterministic persistent sessions, and supports QR credential binding |
| Keep heartbeat delivery idempotent and record occurrence keys | DSH Schedule is at-least-once around crash windows and background scheduling is outside cold Sessions |
| Use DSH Session as the conversation source while retaining domain-owned semantic memory files | Avoids duplicating raw chat persistence while preserving the requested Memory Tree semantics |
| Persistence read APIs require Zod schemas | Syntactically valid but structurally invalid state must fail at the boundary rather than flow into domain logic |
| Memory uses one recoverable workspace writer boundary | Consolidation, proposals, projections, cursors, and revisions share crash recovery and cannot overwrite one another |
| Cordis service construction is filesystem-lazy | Bundle registration must not create project data or launch unowned asynchronous work before first use |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| No existing codebase to follow | Establish a minimal pnpm/TypeScript monorepo with focused packages and explicit ports |
| Live DSH and QQ may require downloads/credentials | Separate contract-level automated verification from optional live smoke tests |
| Initial lint script only performed typechecking | Spec review caught it; added an actual ESLint flat configuration and exact dependencies |
| No-config Memory plugin polluted the repository with a writer lock | Systematic debugging traced eager `MemoryService` construction; changed plugin and startup to lazy, caller-owned initialization |

## Resources

- User-supplied implementation note: `C:\Users\ALmerb\.codex\attachments\32c5f94e-f079-4d53-be48-cd1cdd775540\pasted-text.txt`
- DSH official repository: https://github.com/deepseek-ai/deepseek-harness
- DSH app boot/profile docs: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md
- DSH schedule docs: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/schedule/schedule/README.md
- DSH skill filesystem docs: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md
- Tencent QQ plugin: https://github.com/tencent-connect/dsh-qqbot
- DSH Session subsystem: https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session
- DSH persistence subsystem: https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence
- DSH Goal subsystem: https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/goal
- DSH plugin tutorial: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md

## Visual/Browser Findings

- None yet.
