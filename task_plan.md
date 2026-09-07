# Web admin implementation

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
