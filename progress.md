# Web admin progress

## 2026-09-09 model configuration hot update

- Started implementation planning and preserved the existing dirty planning/documentation baseline.
- Confirmed reusable admin primitives: validated routing, CSRF protection, mutation audit, SSE refresh, and atomic JSON persistence under the project root.
- Decision recorded: admin save directly and atomically updates the durable model configuration, then publishes the new in-memory selection for future Agent creation; in-flight work is not mutated.
- Inspected pinned DSH model services. Chosen integration is the public `agentDefaultModel.saveSelection/currentSelection` contract backed by DSH settings, rather than a second Host-owned store.
- Identified the concrete hot-update defect: the Host registry snapshots model options at registry construction instead of at Agent create/resume time.
- Scoped out QQ commands after discussion; continuing only the durable model settings and management-page hot-update feature.
- Logged one read-only package-path miss caused by a truncated pnpm package name; no retry of the same guessed path.
- Abandoned broad transitive-package discovery after a PowerShell reserved-variable error; no production files were affected.
- Relevant clean baseline passed: 19 Host/admin test files, 113 tests, exit 0.
- Saved the decision-complete implementation/deployment plan at `docs/superpowers/plans/2026-09-09-model-configuration-hot-update.md`.
- TDD Task 1 RED: model-settings test failed because the adapter module was absent. GREEN: new DSH settings adapter tests pass 3/3, including revisioned replacement, safe view, conflict mapping, and missing-service failure.
- TDD Task 2 RED: `/api/model` returned 404 at both backend and HTTP allowlist boundaries. GREEN: GET/PUT model API, strict no-secret payload, revision conflict, CSRF route, and live status projection pass 18/18 focused tests.
- TDD Task 3 RED reproduced both creation-time model snapshotting and missing foreground reload. After correcting a diagnostic test-fixture scope error, dynamic registry resolution and idle-boundary foreground reload pass 29/29 tests.
- Wired authenticated model updates into the production Host: foreground and hidden Agents drain at idle, are disposed, and future resumes resolve the latest DSH selection. Focused Host/API/bridge tests pass 50/50 and Host typecheck passes.
- TDD frontend RED confirmed the model-normalization helper was absent. Added the model settings page with revisioned save, configuration-path and hot-update semantics; frontend tests pass 5/5 and the production Vite build passes.
- Full local verification passed after implementation: lint, typecheck, 68 test files / 337 tests, production build, and `git diff --check` all exited 0.
- Browser acceptance visibly confirmed the desktop model settings page, exact target model, config path, hot-update state and no key field. Post-interruption authenticated HTTP smoke confirmed revision 0 -> 1, exact target selection, `applies=live`, and no secret-shaped response fields.

## Server deployment - 2026-09-07
- Began deployment audit for the 2-core/2GB Alibaba Cloud server.
- Confirmed user will populate the environment file; credentials will not be read or written by the agent.
- Chosen safety baseline: preserve Nginx, keep admin on loopback, inspect before mutating, and use bounded build/runtime memory.
- Read-only server audit completed: Ubuntu 22.04, 2 CPU, 1.6GB RAM plus 4GB swap, 16GB disk free; Nginx active/config valid; port 3182 free.
- Found Node 18.20.8 and no active pnpm, below the repository's Node >=24 requirement. Next: inspect NVM and model configuration before writing deployment assets.
- Confirmed NVM 0.40.3 is installed with only Node 18.
- Identified and stopped `yuncang-frontend`, `yuncang-backend`, and `yuncang-mysql`; no containers or data were removed.
- Post-stop verification: available RAM about 936MB, swap unused, old ports released, Nginx active and syntax valid. Server capacity is now adequate with low-memory deployment limits.
- Added test-first Linux deployment contracts. RED: missing renderer/template caused 2 expected failures; GREEN: 3/3 focused tests pass.
- Added `.env.server.example`, `scripts/render-systemd.mjs`, and `docs/LINUX_DEPLOYMENT.md`; generated unit caps RAM/CPU/tasks and does not mention Nginx.
- Full local `pnpm verify` passed: lint/typecheck/build plus 61 test files and 302 tests. `git diff --check` passed.
- Found `.env.server.example` was ignored by `.env.*`; added a failing regression assertion, then `!.env.server.example`. Focused tests returned to 3/3 and lint passed.
- Pushed deployment commit `c4bc63b`; installed Node v24.20.0 successfully from npmmirror and set NVM default to 24.
- Cloned GitHub `main` at `c4bc63b` to `/opt/dshp`.
- Dependency attempt did not start: Corepack prepared pnpm but no `pnpm` shim existed. Logged the exact error; next approach is the explicit cached `corepack pnpm@11.7.0` command.
- Explicit Corepack pnpm check returned 11.7.0; actual dependency install then completed once in 24.9s (613 packages, native postinstalls succeeded).
- Root production build completed backend `tsc -b` but failed when its nested frontend step called the absent bare `pnpm` shim. Memory remained about 919MB available and swap unused. Plan: verify backend dist and run only the missing frontend build once.
- Verified backend Host CLI artifact, then ran only the previously missing admin frontend build; Vite production build passed and admin assets exist.
- Installed `/etc/dshp/dshp.env` as `0600 root:root` and `/etc/systemd/system/dshp.service` as `0644 root:root`; generated unit pins Node v24.20.0 and passed systemd verification with no DSHP-unit warning.
- Reloaded systemd only. `dshp` intentionally remains inactive/disabled until credentials are populated; Nginx remains active.
- Added a failing documentation regression for bare pnpm use, replaced all server commands with explicit Corepack invocations, then focused tests passed 3/3 and lint passed.
- After credentials were populated, first systemd start failed in DSH plugin-tree loading; service was stopped to prevent a restart loop and Nginx stayed active.
- Clean-environment recursive diagnostics found `ERR_MODULE_NOT_FOUND` for bare `@deepseek-ai/dsh-schedule` resolved from the isolated profile directory.
- Added a failing Linux resolution regression (2 expected failures), implemented `scheduleModulePath()` using an absolute file URL, and restored composition tests to 5/5.

## Previous Web admin progress

## 2026-09-07
- Approved plan accepted; inspected pinned SDK and real Host code.
- Baseline direct Vitest: 54 files / 269 tests passed (14.99s).
- Branch creation denied by Git filesystem permission, reported once. User prefers current directory on a new branch; command left for user.
- Implementation begins with test-first authentication and management contracts.
- User completed pnpm install after non-TTY guard; dependencies available.
- Added prompt/files/Heartbeat state tests: 4 passed; backend Memory/session boundary tests: 2 passed.
- Host integration in progress; scopes prompts through public variable + persona section, literal-safe and per-turn frozen.
- First auth subagent unavailable (503); replacement standard-model agent implementing server and token CLI.
- Auth server finished; focused security suite 14/14 passed, including token rotation, cookie revocation, CSRF, Origin/Host, SSE and path guards.
- Spec review passed after prompt projection isolation and foreground-only recent-interaction fixes. Quality review identified numeric timestamp parsing; RED then GREEN 4/4 frontend tests.
- Root verified native user/message payload in pinned SDK. Corrected direct content/source handling in admin model/status; RED 2 failures then GREEN 7/7 frontend/backend tests. Native Host listener follow-up delegated separately.
- Production build passed. Added fixed-session official schedule tool/read-only session adapter contract regression.
- Isolated browser fixture successfully logged in, rendered desktop overview and native user/assistant session events. Hidden-session list and switching verified; desktop scrollWidth <= viewport.
- Real live launch started HTTP management but QQ network failed EACCES. Did not retry; no production Token values exposed.
- Browser acceptance passed: synthetic Memory create persisted and list refreshed; SOUL new version saved; background manual run displayed completed/NOOP; hidden session switching remained read-only; desktop and 390x844 screenshots inspected without horizontal overflow; logout removed protected UI; stopping fixture displayed connection interrupted and stale-data notice.
- Stopped both agent-created fixture processes (21000, 21008) and drained their shell sessions. Browser viewport override reset. Generated ignored fixtures retained only as test artifacts; production workspace untouched by browser acceptance.
- Native Host listener regression used SDK message constructors, covering user/schedule contents in Memory and schedule-only wake. Focused 2 files/4 tests passed; Host typecheck passed. Independent final spec review approved.
- Final `pnpm verify`: exit 0; lint/typecheck passed; 60 test files / 299 tests passed (14.87s test duration); production Vite build passed. `git diff --check`: exit 0 (only normal LF/CRLF warnings).
- All requested implementation work and local/mock verification complete. Real Tencent/model and official live Schedule restart acceptance remains operator-run due the single EACCES failure. No branch creation retry or commit; existing edits retained.

## SSH continuation 2026-09-07
- Read handoff and verified local two-file dirty baseline. SSH read-only check succeeded.
- Initial host typecheck and lint passed. Added POSIX case/root and Windows containment tests; case regression failed as expected, then limited case folding to Windows.

- GREEN: host suite 12 files / 86 tests; targeted eslint and host tsc build exit 0; diff check clean. Commit 6095aa5 pushed to main.
- Attempted remote git pull once within 60-second bound, chained build/start conditional on success. Command ended with exit 1/no output. No retry.
- Independent read-only follow-up: HEAD 18fd337, clean repo, DSHP inactive/dead with prior exit status 1 and prior 4 restarts, Nginx active; no remaining pull/build process.
- Handoff: user runs ssh root@123.57.154.12, cd /opt/dshp, git pull --ff-only; agent can then continue bounded build and start/log checks.

- User explicitly authorized Git configuration diagnosis and modification. Applied only /opt/dshp repo-local settings with backup; effective values verified.
- Both bounded probes recorded exit 124. New-config pull attempted once; remote remains 18fd337, build/start not executed. Pull handed back to operator under one-attempt rule.

## Deployment running
- Operator completed GitHub pull to 6095aa5. Agent built dsh-host once with heap cap 768MB and started systemd.
- Verified actual service logs (redacted), loopback listener, public page HTTP 200, authenticated status QQ ready/lifecycle running, login/logout success, empty schedules/sessions read success.
- Service remains active with zero restarts, enabled for boot. No test message sent to QQ; real reply and first foreground Agent creation remain operator acceptance.
- Final checks cover unauthenticated API rejection, unchanged Nginx process, env file permission 0600, and remote source status.

- User closed competing local AppID service and requested message receipt check. Read redacted systemd logs, application traces, authenticated status/session counts. Confirmed three received messages followed by processing failures; no messages sent or service changes made.

- Investigated continued inbound processing_failure after AppSecret update; bounded offline QQ stub reproduction confirmed missing required DSH tools: pwsh.
- Added Windows/Linux/macOS positive and wrong-shell/missing-shell negative tests. RED reproduced original error, GREEN 12 files/87 tests; lint/build/diff check passed. Pushed 7093184.
- Remote pull/build deployment attempt in progress; no network retries.

- Deployment pull hit its 60s bound/no output and command exited 1. Due set -e, stop/build/start not reached. No retry under user instruction. Read-only follow-up confirms old 6095aa5 still serving; fix is pushed but not deployed.

- Deployed 7093184 after operator pull: stopped service, host build exit 0, repeated original diagnostic with no QQ connection/sends and no model invocation. Required tools and foreground Agent initialization both pass, diagnostic exit 0. Started service successfully, zero restarts.

## 2026-09-08 Next-step planning
- Read writing-plans and planning-with-files skills; catch-up returned no additional report.
- Inspected Host/Memory state, Skill validation, current deployment guide and public adapter boundaries.
- Wrote docs/superpowers/plans/2026-09-08-host-completion.md with sequential fixes, regression cases, batch recovery, low-memory deployment, rollback and live acceptance.
- No implementation, network connection, server mutation or new test run in this planning turn. Previous 308 passing tests are historical evidence only.
- Read-only search errors: PowerShell literal wildcard path unsupported by rg; top-level @deepseek-ai directory absent. Switched to actual packages/dsh-host/node_modules dependency path; no download or permission retry.

## 2026-09-08 heartbeat incident (priority)
- Server 7093184 active, zero restarts. Durable background occurrence at 2026-09-07T14:39:22.933Z failed core_error; two history Dream/apply operations completed before failure.
- Read all concatenated zstd frames of maintenance session: real model final output was {"action":"NOOP"}; turn completed normally. Strict AgentAction requires type and NOOP.reason. Root cause is underspecified model output contract, not QQ/network.
- Tests reproduced invalid_union_discriminator from exact response. Added complete per-role examples, one bounded correction, strict validation and safe admin error codes. Host 92 tests passed; tsc/eslint/diff check passed.
- Created branch codex/host-completion, preserving existing planning edits. Independent review pending before priority deployment.

## 2026-09-08 priority incident resolved
- Hotfix 78d8193 deployed by Git bundle over SSH; avoided unreliable server GitHub pull. Consistent runtime/workspace backup at /opt/dshp-backups/20260908-before-heartbeat-78d8193.tar.gz.
- First deployment script stopped before build due CRLF terminal syntax; corrected transport with tr -d carriage returns, bounded build then succeeded, service restored active with zero restarts.
- Authenticated real background run verify-hotfix-78d8193 completed NOOP, no error, 2026-09-08T04:27:50.998Z to 04:27:52.513Z. lifecycle running, QQ ready, pending memory/outbound 0.
- Also cleared stale previous reply per turn and guarded hidden agents read-only, including scoped schedule tools. Host 93 tests and tsc/eslint pass.
- Continuing planned Skill/context/multi-fact work after priority live verification.

## 2026-09-08 resumed after quota interruption
- Preserved all implementation edits; server remains 78d8193 active, zero restarts.
- Previous full parallel tests had timeout/resource-sensitive failures in old Runtime fixtures; isolated reliability suite now passes 8/8 (5.2s). Running complete suite serially without changing assertions.
- Skill helper and actual registered foreground tool, full context provider, durable multi-fact batches implemented; integration tests use actual domain services.
- Offline smoke verifies actual locked DSH filesystem skill provider list/get, 3-fact replay after commit-before-ack crash, and context inputs.
- Still required: completed full verification, independent review, code/docs commit, server bundle deployment, offline/live model smoke, authenticated heartbeat check.

## 2026-09-08 final server evidence after quota resume
- Recovered deployment session 74350: exit 0, server build/offline smoke successful, service active and zero restarts. Server HEAD confirmed 3e73f04.
- Isolated live model smoke exited 0 in approximately 9 seconds: modelMemoryFacts=3, modelSkillCreated=true, sdkCatalogLoaded=true, memoryReplay=passed, qqSends=0.
- Authenticated production job verify-completion-3e73f04 ran 11:58:19.979Z–11:58:21.315Z: completed, NOOP, no error. Lifecycle running, QQ ready, pending memory/outbound zero.
- Updated docs/HOST_ACCEPTANCE.md with actual deployment SHA, backup and live evidence. Full QQ delivery/process-restart reminder acceptance remains untested. Feature review attempt previously failed with provider 503; do not count it as review approval.
