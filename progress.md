# Web admin progress

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
