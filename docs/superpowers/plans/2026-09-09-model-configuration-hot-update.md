# Model Configuration Hot Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the Host's default model selection in the DSH settings document, edit it from the authenticated management page, and apply it to subsequent model work without restarting the service.

**Architecture:** Reuse the pinned DSH `agent-default-model` settings namespace and `$DSH_HOME/settings.yaml`; do not introduce a second Host-owned model file. A Host adapter exposes a narrow model-settings port with revision-checked writes. After a successful atomic settings write, cached Agents are drained and disposed so their next resume captures the new selection, while any in-flight turn finishes on its original model.

**Tech Stack:** TypeScript, React, Vitest, Cordis/DSH public settings and Agent APIs, Vite, systemd deployment.

---

## File Structure

- Create `packages/dsh-host/src/admin/model-settings.ts`: narrow adapter over `ctx.settings` and `ctx.agentDefaultModel`, including conflict translation and document metadata.
- Create `packages/dsh-host/test/model-settings.test.ts`: adapter, revision, and validation-contract coverage.
- Modify `packages/dsh-host/src/admin/backend.ts`: `/api/model` read/write routes and live status projection.
- Modify `packages/dsh-host/src/admin/server.ts`: authenticated method allowlist for the model endpoint.
- Modify `packages/dsh-host/src/bridge.ts`: idle-boundary foreground Agent invalidation.
- Modify `packages/dsh-host/src/plugin.ts`: dynamic model resolution, hidden-Agent invalidation, adapter wiring, and status updates.
- Modify `packages/dsh-host/test/{plugin,bridge,admin-backend,admin-server}.test.ts`: hot-update and security regressions.
- Modify `packages/admin-web/src/{main,model,styles}.tsx|.ts|.css`: model settings navigation/editor and form helpers.
- Modify `packages/admin-web/test/client.test.ts`: pure client validation/normalization tests.
- Modify `docs/HOST_ACCEPTANCE.md`: configuration source, hot-update boundary, and deployment evidence.

### Task 1: Model settings adapter

- [ ] **Step 1: Write failing adapter tests**

Add tests proving `view()` returns the resolved provider/model, revision, and settings path; `update()` sends a complete replacement with `expectedRevision`; a `SETTINGS_CONFLICT` becomes `AdminError(409, 'model_conflict')`; no credential field is accepted or returned.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run packages/dsh-host/test/model-settings.test.ts`

Expected: FAIL because `admin/model-settings.ts` does not exist.

- [ ] **Step 3: Implement the narrow port**

Use this public shape:

```ts
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelSettingsView {
  selection: ModelSelection
  revision: number
  configPath: string | null
  applies: 'live' | 'restart'
}

export interface ModelSettingsPort {
  view(): ModelSettingsView
  update(selection: ModelSelection, expectedRevision: number): Promise<ModelSettingsView>
}
```

Find only the `agent-default-model` descriptor through `settings.describe({ redactSecrets: true })`, call `settings.replace(namespace, selection, expectedRevision)`, and translate the stable conflict code without exposing provider errors.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm exec vitest run packages/dsh-host/test/model-settings.test.ts`

Expected: PASS.

### Task 2: Authenticated admin API

- [ ] **Step 1: Write failing backend and HTTP-boundary tests**

Extend the backend fixture with a real in-memory `ModelSettingsPort`. Assert:

```ts
expect(await call('GET', '/api/model')).toMatchObject({
  selection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  revision: 0,
})
await call('PUT', '/api/model', {
  selection: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash-expires-on-0910' },
  expectedRevision: 0,
})
```

Also assert unknown keys/API keys are rejected, stale revisions return 409, unauthenticated access returns 401, and mutation still requires Origin plus CSRF.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run packages/dsh-host/test/admin-backend.test.ts packages/dsh-host/test/admin-server.test.ts`

Expected: FAIL because `/api/model` is not routed/allowlisted.

- [ ] **Step 3: Implement GET/PUT routes**

Validate provider/model as trimmed bounded route/model identifiers, accept optional bounded `reasoningEffort`, require a non-negative integer revision, delegate to the port, and include the live model view in `/api/status`.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same two-test command; expected PASS.

### Task 3: Safe hot-application to Agent instances

- [ ] **Step 1: Write failing registry and Bridge tests**

Add one registry test that changes `currentSelection()` between two Agent creations and expects different `agentOptions`. Add one Bridge test that starts an inbound turn, calls `reloadForeground()`, proves the old Agent is not disposed until the turn is idle, and proves the following message resumes a new Agent instance.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run packages/dsh-host/test/plugin.test.ts packages/dsh-host/test/bridge.test.ts`

Expected: registry still uses its construction-time snapshot and Bridge lacks the reload method.

- [ ] **Step 3: Implement the idle boundary**

Resolve `agentDefaultModel.currentSelection()` inside every registry `create/resume` call. Add `PersonalGrowthBridge.reloadForeground()` by chaining behind `processing`, awaiting the current Agent's idle state, clearing the cached reference, and disposing the old handle. In Host, serialize hidden-Agent reloads similarly, clearing them only after their active turn settles.

- [ ] **Step 4: Wire model updates**

Construct the model-settings adapter in `apply()`. On a successful write, refresh `HostStatus.model`, await foreground reload, and drain hidden Agents. Keep the file write authoritative if a later Agent disposal reports an operational error; log a safe model-reload diagnostic so restart remains a deterministic fallback.

- [ ] **Step 5: Run tests and verify GREEN**

Run the focused registry/Bridge/model/backend tests; expected PASS.

### Task 4: Management page editor

- [ ] **Step 1: Write failing pure UI tests**

Add helpers that trim a model form and reject blank provider/model values while preserving an optional reasoning effort. Verify the target model ID remains unchanged.

- [ ] **Step 2: Run the client test and verify RED**

Run: `pnpm exec vitest run packages/admin-web/test/client.test.ts`

Expected: FAIL because the helpers do not exist.

- [ ] **Step 3: Implement the Models page**

Add a `模型设置` navigation item with provider, model ID, optional reasoning effort, read-only config path, and a clear note: saving writes the config file directly; in-flight work finishes on its old model; subsequent work uses the new model. Submit:

```ts
api<ModelSettingsView>('model', 'PUT', { selection, expectedRevision: revision })
```

On success replace local state/revision and refresh SSE-backed status; on 409 tell the user to reload.

- [ ] **Step 4: Run client tests, typecheck, and production build**

Run: `pnpm exec vitest run packages/admin-web/test/client.test.ts`

Run: `pnpm --filter @personal-growth/admin-web typecheck`

Run: `pnpm --filter @personal-growth/admin-web build`

Expected: all exit 0.

### Task 5: Documentation and local acceptance

- [ ] **Step 1: Document persistence semantics**

State that the file is `$DSH_HOME/settings.yaml` (project deployment: `runtime/dsh-home/settings.yaml`), the namespace is `agent-default-model`, writes are locked/atomic and revision-checked, secrets remain in environment/credential storage, and valid external file edits are watched by DSH.

- [ ] **Step 2: Run focused and full verification**

Run focused Host/admin tests serially, then `pnpm lint`, `pnpm typecheck`, `pnpm build`, the full serial test suite, and `git diff --check`. Do not claim completion from partial output.

### Task 6: Commit, push, and server rollout

- [ ] **Step 1: Review the exact diff and preserve unrelated changes**

Stage only feature code/tests/docs plus the existing task records intentionally updated for this work. Do not stage credentials, runtime state, or generated local settings.

- [ ] **Step 2: Commit and push the feature branch**

Create one descriptive commit and push `codex/host-completion`. If the deployment convention requires `main`, fast-forward/merge only with the user's already stated deployment intent and without rewriting history.

- [ ] **Step 3: Deploy with low-resource bounds**

On the server, create a recoverable backup, update source, stop the service only for the bounded build/install window, run the established Node 24/Corepack build path, and restore/start systemd. Preserve Nginx and the credential environment file.

- [ ] **Step 4: Set the production model through the persisted settings path**

Write the `agent-default-model` section through the authenticated admin API when available (preferred, because it exercises revision and hot reload) or through a locked atomic settings edit while the service is stopped. Set:

```yaml
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4.1-flash-expires-on-0910
```

- [ ] **Step 5: Verify production evidence**

Confirm systemd active with zero new restarts, admin listener still loopback-only, `/api/model` and `/api/status` show the exact model ID, the settings file contains the non-secret selection, Nginx remains unchanged, and one minimal real-model smoke returns through the configured Host path without sending QQ messages.

## Scope Boundary

QQ slash commands (`/new`, `/status`, `/model`) are not part of this plan. The model-settings port is intentionally reusable by a later command router.
