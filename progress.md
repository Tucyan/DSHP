# Web admin progress

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
