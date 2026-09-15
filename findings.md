# Web admin findings

## 2026-09-15 in-turn multi-message delivery

- The worktree is clean on `codex/host-completion`, tracking `origin/codex/host-completion` at `b17a1a0`.
- QQ already has durable outbound claim/complete/fail states and rejects unresolved pending sends as `OUTBOUND_UNCERTAIN`; the new design should reuse this mechanism instead of adding a second delivery ledger.
- `FakeQqAdapter.send` already deduplicates confirmed `idempotencyKey` values and prohibits `background` sends.
- Existing root planning files contain historical deployment work and must be extended rather than replaced.
- `PersonalGrowthBridge.process` currently waits for the whole Agent turn, derives one final assistant text, sends it with `${sessionId}:turn:${inboundMessageId}`, and then records only that final text for the fallback memory path.
- In production, the Host `session/event` observer captures the final `assistant/message` at `turn/end`, calls `observeActiveUserReply`, and the bridge suppresses its fallback send through `observed`; this is the automatic final-forwarding path that must be removed.
- Global tools are registered through DSH `defineTool`. Foreground and hidden Agents share the registry, while hidden setups already restrict/guard tools; the new send tool must additionally verify the executing Agent/session so global registration cannot bypass permissions.
- Production memory consumes native session events in `consumeStandaloneTurn`; if tool-triggered sends are appended as assistant session events by DSH, they naturally enter history once. The implementation must confirm that behavior or explicitly supply one durable history event per confirmed send.
- Agent turn sequencing is serialized in `PersonalGrowthBridge.processing`, and outbound delivery is serialized by awaited tool execution plus `FileBridgeState` claim state. A per-turn ordinal can form stable keys such as `${sessionId}:turn:${messageId}:send:${ordinal}`.
- Inspection attempted a nonexistent `packages/qq-adapter/src/contracts.ts` and a Windows-invalid glob under `node_modules/.pnpm`; neither changed files. Continue from the real `port.ts`/`durable-port.ts` files and resolve package paths with `rg --files`.
- DSH exposes the executing `Agent` and immutable `callId` to every `ToolRunContext`; the Agent exposes its durable `session`, whose append-only log supports plugin-augmented event types. This provides a public way to persist a sent-message event without corrupting the ordered model surface.
- A dedicated non-surface `personal-growth/message-sent` event avoids inserting a synthetic assistant message between `tool/call` and `tool/result`, while still giving admin history and the Host memory consumer the exact confirmed body.
- The immutable delivery rules should be installed as a Host system-prompt section, with `workspace/AGENT.md` and the bootstrap default kept consistent for operational clarity.

## 2026-09-09 model configuration hot update

- `AdminBackend` already centralizes validated routes, mutation auditing, and safe error translation; `admin/server.ts` separately allowlists HTTP methods and paths.
- `SafeAdminFiles.write/change` already uses project-root containment and atomic temporary-file rename, so the model configuration can reuse the same durable JSON pattern.
- `HostStatus.model` is currently populated once during Host apply. It must instead reflect the live selector after a successful update.
- Current model resolution enters through DSH `agentDefaultModel.currentSelection()`. The hot-update design must preserve the selected provider/model snapshot per Agent while allowing subsequent Agent creation to observe a newer selection.
- Secrets are outside scope: `DEEPSEEK_API_KEY` stays in the environment and must not appear in the file or admin payload.
- Pinned DSH `@deepseek-ai/dsh-agent-default-model` exposes `currentSelection()` and `saveSelection(next)`. Its settings section is explicitly documented as applying to future Agents and reading the mounted settings user layer live.
- The DeepSeek adapter also resolves provider settings per request, but the requested feature only needs provider/model/reasoning selection; endpoint/API-key editing remains out of scope.
- `createDshAgentRegistry` currently resolves `agentOptions` once when the registry is constructed, so it defeats the DSH live selector. Moving resolution inside each `resume/create` call is required for hot updates to affect future Agent instances.
- `openHiddenAgent` already resolves the default selection at each hidden-agent creation, but its cached hidden Agent stays on the model it was created with. This is the desired in-flight/existing-instance boundary unless an explicit disposal/reopen policy is added.
- The DSH Agent model selection is step-snapshot based (`ModelSelectionRef.current` is captured during prompt assembly and reused for that request). A concurrent switch can safely affect a later step without splitting one request across models, but Host must obtain or own the mutable reference; plain `agentOptions` are otherwise creation-time facts.
- QQ commands (`/status`, `/model`, `/new`) are explicitly out of scope per user direction. No command parsing or session-ID changes will be made in this task.
- The upstream base bundle already documents `$DSH_HOME/settings.yaml` as hot-reloaded and as the file written by model configuration surfaces. File writes use a cross-process lock plus atomic replacement and preserve unrelated YAML sections/comments.
- Agent loop reads `agent.options.provider/model` when each request is built, but the options object has no public mutation API. The supported Host boundary is therefore to finish active work, dispose the cached Agent handle, and resume the same durable session with new options.
- User requested final commit/push, server rollout, and production model selection `deepseek-v4.1-flash-expires-on-0910`; real direct API validation already returned HTTP 200 for this exact ID.

## Server deployment (active)

- User's server is accessed through the currently open Alibaba Cloud ECS Workbench browser tab.
- Target capacity is 2 CPU / 2GB RAM; deployment must avoid concurrent builds/tests and use explicit memory limits.
- Existing Nginx must remain unaffected; prefer the app's loopback-only port 3182 and an SSH tunnel for admin access.
- GitHub source repository is public at https://github.com/Tucyan/DSHP and local `main` tracks `origin/main`.
- Server audit: Ubuntu 22.04.5 LTS x86_64, 2 CPUs, 1608MB RAM (about 301MB available during audit), 4095MB swap unused, and about 16GB free on `/`.
- Nginx is active and `nginx -t` succeeds. It owns public ports 80/443; other current listeners include 22, 3306, 8080 and 18080 plus loopback 3030/8000. Port 3182 is free.
- Installed tools: Git 2.34.1, Node v18.20.8, Corepack 0.32.0, no globally active pnpm. The repository requires Node >=24, so the active Node must be switched or installed before deployment.
- Root has an existing `.nvm` directory, so inspect available NVM versions before choosing an installation path.
- NVM 0.40.3 is installed, but only Node v18.20.8 is present; no Node 24 installation exists yet.
- Explicitly authorized old-service shutdown identified three Docker containers: `yuncang-frontend` (18080), `yuncang-backend` (8080), and `yuncang-mysql` (3306).
- The three containers stopped cleanly without deletion. Available RAM rose from about 301MB to 936MB, swap remained unused, and ports 8080/18080/3306 were released.
- Nginx remained active and `nginx -t` still succeeded after the old containers stopped.
- Capacity conclusion: adequate for one bounded DSHP runtime if dependencies/build run serially, Node heap is capped around 768MB, server tests are skipped, and Nginx remains separate.
- First systemd start reached DSH composition but failed because the Host overlay inserted `@deepseek-ai/dsh-schedule` as a bare package name. The loader resolves Host-overlay entries from the isolated profile directory, which has no node_modules. Host itself already uses an absolute file URL, establishing the correct pattern.
- A direct diagnostic initially reported an invalid Peer ID because the audit shell retained old empty exported values and Node `--env-file` does not override inherited variables. Removing inherited variables reproduced the true systemd error; no credential value was printed.
- Root-cause fix: resolve the installed Schedule entry with `createRequire(import.meta.url)` and pass its absolute `file:` URL in the Host patch.

## Previous implementation findings

- DSH 0.1.1-rc.2 public SessionPersistence.inspect/readFrom are read-only; load commits recovery and is forbidden for browsing.
- Public SystemPrompt.section supports scoped dynamic providers; snapshots must be frozen per turn, since assembly runs per model step.
- Public schedule tools schedule_create/list/delete own durable changes. Do not write schedule events manually.
- Host foreground is derived from configured QQ peer; hidden roles decision/dream/maintenance share ID prefix.
- Existing Host wakeForeground drops the WakeResult, preventing Bridge proactive send. Fix and regression-test it.
- MemoryService supplies controlled apply/list/read/search/projections and safe filesystem boundaries; revisions contain metadata, not full historical snapshots.
- Existing architecture page on 3181 is static and must remain separate from live admin.
- Existing dirty changes are README/package scripts, Host and Runtime CLI fixes, architecture explorer, and operational workspace state. Never read credential contents or overwrite operational data.

- Direct SSH is available; remote code clean at 18fd337. Initial typecheck and targeted lint pass.
- Canonical containment used Windows separators. Existing fix also folded POSIX case; regression reproduced false acceptance of /opt/DSHP under /opt/dshp.

- 6095aa5 fixes native-separator canonical containment and retains case sensitivity for POSIX, with Windows/POSIX boundary regressions.
- Remote update attempt did not advance HEAD; pull produced no diagnostic and outer command exited 1. The pull was bounded with timeout 60; no network timeout cause can be conclusively inferred from missing output.
- No server build or start was reached; pwsh hypothesis remains unconfirmed.

- Git configuration investigation: origin is official GitHub HTTPS; no configured/env proxy or URL rewrite found; DNS resolves github.com to 20.205.243.166. Global http.postBuffer=524288000 and http.sslVerify=false existed before this turn.
- Baseline trace: TCP/TLS completed and HTTP/2 GET was sent, then no response; bounded ls-remote exit 124 at 30s.
- Backed up remote .git/config to .git/config.before-http-fix-20260907. Set repo-local http.version=HTTP/1.1, http.sslVerify=true, http.lowSpeedLimit=1, http.lowSpeedTime=20.
- One pull with new settings timed out at 45s, trace stopped at Trying 20.205.243.166:443 before TLS. GitHub connection instability remains unresolved; not established as HTTP/2-specific. No further pull retries.

- Deployment now runs at 6095aa5 after operator pull succeeded. Bounded server host build completed successfully in about 5 seconds; systemd enabled/active with NRestarts=0.
- Admin listener verified at 127.0.0.1:3182 only; homepage 200, real token login/logout 200, status lifecycle=running and qq=ready; configured model deepseek-official/deepseek-v4-flash; pending memory/outbound zero.
- Authenticated schedules and sessions reads return 200 and empty lists. These reads do NOT create the foreground Agent, so they do not validate lazy agent tool assertions or model replies. pwsh hypothesis remains unconfirmed; do not preemptively modify.
- Nginx PID 2567685 and active timestamp Sep 6 00:51:36 CST retained; no nginx modifications. Runtime memory about 122 MiB.

- QQ log check at 2026-09-07 21:53 +08: inbound claimed at 21:46:01, 21:46:38 and 21:51:20, each followed by processing_failure within 100ms. Server definitely received messages; application processing failed. Journal contains no detailed exception. QQ status ready, service active NRestarts=0, one persisted session, lastInteraction null. Exact root cause (including pwsh hypothesis) remains unconfirmed.

- Root cause reproduced with no-QQ diagnostic boot and real foreground session resume: registered tools include bash, but assertRequiredAgentTools rejects missing pwsh. No model turn or message sent.
- Initial stdin diagnostic failed because HMR requires process.argv[1]; corrected diagnostic entrypoint then captured exact capability error. Service restored after each short probe.
- Fix 7093184 selects pwsh on win32 and bash elsewhere while preserving all other mandatory tools. Regression fails before fix; 87 Host tests/lint/tsc build pass after fix.

- Server regression verified on 7093184: required_tools=passed; bash=true; agent_initialization=ok. Original missing-pwsh failure resolved in same real SDK/session resume path. Actual QQ/model reply still requires user test.

## 2026-09-08 Host completion planning findings
- Skill foreground/background both generate a description rejected by the real ExtensionWriter. Preserve narrow-trigger validation and share draft construction.
- Multi-fact support needs BOTH Host length-limit changes and MemoryService history/proposal dedup changes. Service currently rejects a second distinct revision from the same history.
- Durable history claim/fail currently overwrites/deletes pending state; batch payload must survive these operations before multi-item retries are safe.
- Heartbeat needs persisted fixed-session Goal/Schedule/recent events plus contact ledger, not just memory keywords or admin in-process lastInteraction.
- Production build must rebuild changed runtime/memory dependencies with tsc -b. Existing server is low-memory; full tests remain local, bounded offline smoke and real acceptance run on server.

## 2026-09-08 verified completion
- Server 3e73f04 passes real-model isolated three-fact memory and Skill catalog acceptance; production background heartbeat completes without heartbeat_failed.
- Develop and run the full suite locally; server only needs bounded build and environment-specific smoke. Direct server code editing is unnecessary.
- Memory reopen/replay smoke establishes persistence/idempotency, not real QQ reminder delivery across a process restart.
## 2026-09-15 最终验证状态

- 静态复核确认本次实现覆盖验收路径：同轮可按工具调用顺序发送多条消息；发送后不结束 ReAct 循环；已确认成功的调用重试返回 `already_sent` 且不重复发送；任务结束时不再自动转发普通 assistant 文本；已发送正文通过原生 session event 进入历史与记忆；隐藏/后台 agent 无发送权限；主动联系仍走既有策略。
- 根级 `lint`、`typecheck`、`build` 均以退出码 0 完成。
- 相关聚焦测试最终通过 7 个文件、46 个测试；扩大范围（排除 `production-wake.test.ts`）通过 23 个文件、150 个测试。
- `production-wake.test.ts` 在修复测试桩之前连续 3 次触发 5 秒超时。系统化排查确认测试桩还缺少新前台提示词安装需要的 `systemPrompt.section()`，现已补齐；依据 AGENTS.md 的最多 3 次超时尝试限制，修复后必须由用户执行一次确认，命令为：
  `corepack pnpm@11.7.0 exec vitest run packages/dsh-host/test/production-wake.test.ts --reporter=verbose`
- 用户已运行修复后的命令并提供通过证据：`production-wake.test.ts` 1/1 通过，总耗时 3.33 秒。当前不存在未通过的本次更新验证项，可以进行 commit 与 push。
