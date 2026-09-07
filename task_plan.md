# Low-resource server deployment

## Goal
Deploy the committed DSHP service to the user's 2-core/2GB Alibaba Cloud server, preserve the existing Nginx service, keep the admin listener private, and leave a documented environment file for the user to populate.

## Active Phases
- [x] Audit local runtime requirements, ports, environment variables, and production entrypoint.
- [x] Inspect server OS, memory, disk, Node tooling, current listeners, Nginx, and service manager without changing state.
- [x] Add only deployment changes required for low-memory operation and private admin access; verify locally and push.
- [x] Install or update the app on the server with bounded resource settings and a protected environment file.
- [ ] Start under the available service manager and verify health, logs, reboot policy, Nginx continuity, and port exposure. (blocked only on user-populated credentials)

## Deployment Decisions
- Do not edit or reload Nginx unless inspection proves a change is required; the admin page must not take ports 80/443.
- Bind the admin HTTP server to loopback and access it through an SSH tunnel unless the user later requests a dedicated Nginx route.
- Build serially and cap Node memory for a 2GB host; avoid running the test suite on the server.
- Create the environment file with placeholders and restrictive permissions; never invent or request secrets in chat.

## Deployment Errors

- Server had Node 18 only; resolved deployment design by using existing NVM with the npmmirror Node mirror. Installation is pending.
- Initial deployment contract test failed as intended because the renderer and environment template did not exist; minimal implementation now passes 3/3 focused tests.
- `corepack prepare pnpm@11.7.0 --activate` cached pnpm but did not create a `pnpm` shim under NVM Node 24; the following install line failed immediately with `pnpm: command not found`, before dependency download. Use the explicit `corepack pnpm@11.7.0` invocation instead of repeating the failed command.
- Server root build ran `tsc -b` successfully, then failed at the nested bare `pnpm --filter @personal-growth/admin-web build` because the shim is absent. Do not rerun the long root build; verify backend artifacts and run only the missing frontend sub-build once through explicit Corepack.
- Deployment guide initially repeated the bare pnpm assumption. A failing documentation regression test caught it; examples now use explicit `corepack pnpm@11.7.0` and split backend/frontend builds.

# Previous completed work: Web admin implementation

## Goal
Implement the approved localhost, token-protected real Host administration UI: status, read-only sessions, controlled Memory CRUD/archive, SOUL/Mission editing, Heartbeat, Schedule, diagnostic and extension viewing.

## Phases
- [x] Inspect current Host and SDK, preserve dirty baseline (54 files / 269 tests pass).
- [x] Authentication HTTP server and credential CLI, with security tests.
- [x] Host management services, prompt versions, Heartbeat configuration and runtime wiring.
- [x] React/Vite Chinese management UI and integration.
- [x] Spec review, quality review, full verification and operator documentation.

## Operator Acceptance Remaining
- Real QQ/model end-to-end and official live Schedule restart checks require launching from the user's terminal. Sandbox Tencent connection failed EACCES; it was not retried. Mock/contract verification is not a substitute for this check.

## Decisions
- Same process with live Host; 127.0.0.1:3182 only, same-origin REST + SSE.
- Auto-generated local ignored token, 8h HttpOnly cookie, CSRF + Origin checks.
- Switching sessions is read-only; hidden sessions collapsed; fixed user's sessions only.
- Memory writes through MemoryService, optimistic hashes; no permanent delete/merge/restore.
- SOUL/Mission editable next turn, internal prompts and permissions immutable.
- No supervisor, browser chat, key editing, or extension execution/deployment.
- Preserve existing edits. No automatic commit. New branch attempt denied by .git permissions; user informed, no retry.

## Errors
- git switch -c codex/web-admin: permission denied creating ref (one attempt); continue file work, no Git mutations.
- Inspection of nonexistent heartbeat config.ts: correct source is contact-policy.ts.
- Real QQ startup: management HTTP started, Tencent request failed EACCES; no restricted-network retry. Live operator validation remains required.
- First full verify stopped in lint on disposable browser fixture build assets; narrow runtime/admin ignore added. No command timeout.
