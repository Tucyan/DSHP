# Low-resource server deployment

## 2026-09-09 Model configuration hot update

### Goal
Move the Host model selection into a durable project configuration file and allow authenticated administrators to update it from the management page without restarting the service.

### Active Phases
- [x] Map the DSH model-selection lifecycle and define the durable/hot-update boundary.
- [x] Write focused failing tests for configuration initialization, atomic update, conflict handling, and new-Agent selection.
- [x] Implement the model configuration store and runtime selector.
- [x] Add authenticated admin API and management-page editor.
- [x] Run focused tests, full verification, and document operational semantics.
- [ ] Commit/push the verified branch and deploy the target model configuration to production.

### Decisions
- The project configuration file is the persistent source of truth; a successful admin save writes it atomically and updates the in-memory selector in the same operation.
- Existing in-flight model calls retain the model captured when their Agent was created. New Agent instances use the newly selected model, avoiding mid-turn mutation.
- API keys remain environment-only and are never exposed or written by the model settings page.
- Local completion is followed by commit/push and bounded low-resource server deployment; production selection must be `deepseek-v4.1-flash-expires-on-0910`.

### Errors
- Agent factory package inspection guessed `dsh-agent-instance` from a truncated pnpm directory name, but that directory actually contained `dsh-agent-instructions`; no file was changed. Switched to package-manifest discovery instead of repeating the guessed path.
- Broad pnpm manifest discovery used PowerShell's reserved automatic `$Matches` variable as an array and failed before producing results. This inspection path is abandoned; implementation will rely on the already verified public DSH type declarations instead of a third broad scan.
- The first full baseline command exceeded the 30-second execution window after reporting only passing tests. It was not repeated unchanged; the relevant Host/admin baseline was run separately and passed 19 files / 113 tests.
- The first plugin wiring patch used stale import adjacency and was rejected before changing the file. Re-read the exact anchors and applied the scoped patch successfully.
- The first frontend test patch used a guessed test title and was rejected before changing the file. Re-read the small test file and applied it against the actual title.
- The browser session lost Codex authorization after the quota interruption, so the already verified desktop view could not be reused for a mobile screenshot. No browser retry loop or dependency download was attempted; responsive behavior remains covered by the existing CSS breakpoint and production build.
- The first post-interruption HTTP smoke found the interrupted fixture process gone; after one fixture restart, the first request omitted the required Origin header and failed closed. The corrected authenticated request then passed without touching production data.
- The first explicit staging command contained a mistyped `dsh-host` path and failed before the commit. Re-ran staging with the verified path list; no files were lost or reverted.

## Goal
Deploy the committed DSHP service to the user's 2-core/2GB Alibaba Cloud server, preserve the existing Nginx service, keep the admin listener private, and leave a documented environment file for the user to populate.

## Active Phases
- [x] Audit local runtime requirements, ports, environment variables, and production entrypoint.
- [x] Inspect server OS, memory, disk, Node tooling, current listeners, Nginx, and service manager without changing state.
- [x] Add only deployment changes required for low-memory operation and private admin access; verify locally and push.
- [x] Install or update the app on the server with bounded resource settings and a protected environment file.
- [x] Start under systemd and verify health, logs, reboot policy, Nginx continuity, and port exposure. Running at 6095aa5; QQ ready and private admin verified.

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
- First real systemd start exposed `ERR_MODULE_NOT_FOUND` for the Host overlay's bare Schedule package specifier. A clean diagnostic confirmed the profile-relative resolution root. TDD fix resolves Schedule to an absolute file URL like the Host module.

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

## 2026-09-07 SSH deployment continuation
- [x] Confirm local changes and remote 18fd337, inactive DSHP, active Nginx, env mode 0600.
- [x] Verify and push Linux path fix (including POSIX case boundary regression).
- [x] Pull/build/start once; diagnose actual logs and verify private admin and stable service.
- Long commands/downloads/permission failures: one attempt; hand timeout execution to user.
- RED: POSIX case boundary test fails because canonical helper lowercases Linux paths.

- [x] Verified path fix: 12 files / 86 tests, lint, host tsc build, diff check; pushed 6095aa5.
- [x] Operator completed remote git pull to 6095aa5 after bounded automated attempts timed out.
- Read-only follow-up confirms remote still 18fd337, DSHP inactive/dead, Nginx active, no pull/build process. Build/start not reached.

- Git network troubleshooting authorized: baseline HTTP/2 response stall, then HTTP/1.1 pull stalls before TCP connection, both bounded timeouts. Config changes applied locally with backup, connectivity remains blocked; no automatic retry.

## Native shell failure
- [x] Reproduce exact foreground capability failure without QQ sends: pwsh missing while bash registered.
- [x] TDD fix and push 7093184 (87 tests/lint/tsc build).
- [ ] Deploy 7093184: single remote pull hit its 60s bound with no output; no retry. Operator must pull manually.
- [ ] Repeat no-message agent initialization diagnostic after deployment; then operator QQ reply acceptance.

- [x] Operator pulled 7093184; server bounded host build passed.
- [x] Same no-message foreground resume diagnostic now passes required tools (bash=true) and agent_initialization=ok, exit 0; service restored.
- [ ] Operator QQ end-to-end reply acceptance remains.

## 2026-09-08 正式 Host 修复计划
- [x] 对照代码确定 Skill / Heartbeat context / multi-fact Memory 三项边界。
- [x] 保存执行计划：docs/superpowers/plans/2026-09-08-host-completion.md。
- [ ] Task 0 基线与锁定 SDK 数据接口。
- [ ] Task 1 正式 Skill 创建/发现/调用组合回归。
- [ ] Task 2 固定主会话的完整心跳上下文。
- [ ] Task 3 可持久恢复的多事实批次与逐项去重。
- [ ] Task 4 正式 Host 集成、全量验证、Linux smoke。
- [ ] Task 5 服务器受限构建、发布及回滚准备。
- [ ] Task 6 真实 QQ/模型/重启验收。
- 本轮只制定计划，未修改业务代码、未连接服务器。

## 2026-09-08 completion deployment verified
- [x] Tasks 0–5: SDK interfaces, Skill creation/catalog, full heartbeat context, recoverable multi-fact memory, local integration and server deployment completed at 3e73f04.
- [x] Local lint/typecheck/build and serial 67-file / 330-test run passed before deployment; server bounded build and offline smoke exited 0.
- [x] Server isolated real-model smoke: 3 memory facts, Skill creation/public catalog load, reopened replay without duplication, zero QQ sends.
- [x] Production background heartbeat verify-completion-3e73f04 completed NOOP without error at 2026-09-08T11:58:21.315Z; lifecycle running, QQ ready, queues empty.
- [ ] Task 6 remaining boundary: user QQ delivery and reminder delivery across a process restart have not been exercised; requires user-triggered input or explicit test-message authorization.
- This update supersedes the earlier unchecked implementation/deployment entries, while retaining historical records.
