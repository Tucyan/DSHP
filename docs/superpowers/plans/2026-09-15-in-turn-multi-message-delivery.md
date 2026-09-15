# In-turn Multi-message Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the fixed foreground user Agent call `send_message(text)` more than once during one ReAct turn, receive a delivery result, continue using tools, and finish without an automatically forwarded duplicate response.

**Architecture:** Add one globally registered but execution-scoped DSH tool whose body delegates to the active `PersonalGrowthBridge`. Bind authorization to the executing Agent id and the bridge's currently owned inbound message; derive each durable outbound id from the foreground session, inbound message id, and DSH tool `callId`. After confirmed delivery, append a dedicated durable session event for the sent body; the existing turn-end memory pipeline consumes those sent events while ignoring unsent assistant narration for user-owned turns.

**Tech Stack:** TypeScript, DSH Agent/Session/Tools public APIs, Cordis, Vitest, existing `FileBridgeState` durable outbound ledger and QQ bridge.

---

### Task 1: Specify the send tool and prompt contract

**Files:**
- Create: `packages/dsh-host/src/send-message.ts`
- Test: `packages/dsh-host/test/send-message.test.ts`
- Modify: `packages/dsh-host/test/critical-gaps.test.ts`

- [x] **Step 1: Write the failing tool-contract tests**

```ts
it('registers send_message with text as its only model argument', () => {
  const definitions: ToolDefinition[] = []
  registerSendMessageTool({ register(tool) { definitions.push(tool); return () => undefined } }, async () => ({ id: 'id', status: 'sent' }))
  expect(definitions[0]).toMatchObject({ name: 'send_message', parameters: { text: { type: 'string', required: true } } })
})

it('binds delivery to the executing Agent and stable tool call id', async () => {
  const calls: unknown[] = []
  const tool = captureTool(async input => { calls.push(input); return { id: 'stable', status: 'sent' } })
  await tool.execute({ text: '阶段结果' }, { agent: { id: 'foreground' }, callId: 'call-1' } as never)
  expect(calls).toEqual([{ agentId: 'foreground', callId: 'call-1', text: '阶段结果' }])
})
```

- [x] **Step 2: Run the focused tests and verify RED**

Run: `corepack pnpm@11.7.0 exec vitest run packages/dsh-host/test/send-message.test.ts packages/dsh-host/test/critical-gaps.test.ts`

Expected: FAIL because `send-message.ts`, `registerSendMessageTool`, and the required tool entry do not exist.

- [x] **Step 3: Implement the minimal tool definition and immutable prompt text**

```ts
export const MESSAGE_DELIVERY_PROMPT = `Use send_message(text) for every user-visible progress update, stage conclusion, and final reply. Each call sends one complete message. After a progress send, continue the task and use other tools as needed. Send only meaningful updates; avoid frequent chatter. Before ending a user task, send the final reply with send_message. Ordinary assistant text is not delivered automatically.`

export function registerSendMessageTool(registrar: DshToolRegistrar, send: SendMessage): () => void {
  return registrar.register(defineTool({
    name: 'send_message',
    description: 'Send one complete message to the user bound to the current foreground conversation, then continue the task.',
    parameters: { text: { type: 'string', required: true, description: 'One complete user-visible message.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, status: { type: 'string', enum: ['sent', 'already_sent', 'pending', 'unknown'], required: true } } },
      render: (_args, value) => [{ type: 'text', text: `message ${value.status} (${value.id})` }],
    },
    execute: (args, exec) => send({ agentId: String(exec.agent?.id ?? ''), callId: String(exec.callId), text: args.text }),
  }))
}
```

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `corepack pnpm@11.7.0 exec vitest run packages/dsh-host/test/send-message.test.ts packages/dsh-host/test/critical-gaps.test.ts`

Expected: all selected tests pass.

### Task 2: Deliver multiple messages during an active foreground turn

**Files:**
- Modify: `packages/dsh-host/src/bridge.ts`
- Modify: `packages/dsh-host/test/bridge.test.ts`
- Test: `packages/dsh-host/test/send-message.test.ts`

- [x] **Step 1: Write failing bridge tests for multiple sends, continuation, stable dedupe, ordering, and denied contexts**

```ts
it('sends two independently identified messages before the foreground turn becomes idle', async () => {
  userAgent.whenIdle = async () => {
    await bridge.sendActiveMessage({ agentId: userAgent.id, callId: 'progress', text: '阶段一' })
    continuedAfterFirstSend = true
    await bridge.sendActiveMessage({ agentId: userAgent.id, callId: 'final', text: '最终结论' })
  }
  await handler(inbound)
  expect(continuedAfterFirstSend).toBe(true)
  expect(bot.sent).toEqual(['阶段一', '最终结论'])
})

it('reuses one durable id for a retried call without sending twice', async () => {
  const first = await bridge.sendActiveMessage({ agentId, callId: 'same-call', text: '一次' })
  const retry = await bridge.sendActiveMessage({ agentId, callId: 'same-call', text: '一次' })
  expect([first.status, retry.status]).toEqual(['sent', 'already_sent'])
  expect(bot.sent).toEqual(['一次'])
})

it('rejects hidden, foreign, and inactive Agent sends', async () => {
  await expect(bridge.sendActiveMessage({ agentId: 'hidden', callId: 'x', text: '禁止' })).rejects.toThrow(/active foreground/)
})
```

- [x] **Step 2: Run bridge/send tests and verify RED**

Run: `corepack pnpm@11.7.0 exec vitest run packages/dsh-host/test/bridge.test.ts packages/dsh-host/test/send-message.test.ts`

Expected: FAIL because the active-message delivery API does not exist and the old final-send behavior still emits a reply.

- [x] **Step 3: Implement active-turn delivery and return durable status**

```ts
async sendActiveMessage(input: { agentId: string; callId: string; text: string }): Promise<SendMessageResult> {
  const sessionId = sessionIdForPeer(this.options.allowedPeerId)
  const inboundId = this.activeMessageIds.get(sessionId)
  if (!inboundId || this.foreground?.id !== input.agentId || input.agentId !== sessionId) throw new Error('send_message requires the active foreground user turn')
  const id = `${sessionId}:turn:${inboundId}:send:${createHash('sha256').update(input.callId).digest('hex').slice(0, 32)}`
  const status = await this.sendOutbound(id, { peerId: this.options.allowedPeerId, messageId: inboundId }, input.text)
  return { id, status }
}
```

Change `sendOutbound` to return `sent | already_sent | pending | unknown`, await every send, and retain the existing pre-dispatch `unknown` transition plus failure throw. Remove the fallback that forwards `assistantText` after `whenIdle`.

- [x] **Step 4: Run bridge/send tests and verify GREEN**

Run: `corepack pnpm@11.7.0 exec vitest run packages/dsh-host/test/bridge.test.ts packages/dsh-host/test/send-message.test.ts`

Expected: all selected tests pass.

### Task 3: Persist sent bodies and make memory reflect actual delivery

**Files:**
- Modify: `packages/dsh-host/src/send-message.ts`
- Modify: `packages/dsh-host/src/plugin.ts`
- Modify: `packages/dsh-host/test/native-user-events.test.ts`
- Modify: `packages/dsh-host/test/send-message.test.ts`

- [x] **Step 1: Write failing history and memory tests**

```ts
it('appends one durable sent-message event after confirmed delivery and does not duplicate it on retry', async () => {
  await tool.execute({ text: '已发送' }, exec)
  await tool.execute({ text: '已发送' }, exec)
  expect(agent.session.events.filter(event => event.type === 'personal-growth/message-sent')).toHaveLength(1)
})

it('consumes sent bodies instead of unsent assistant narration for a direct user turn', async () => {
  turn(2, { kind: 'user' }, 'direct user prompt', 'unsent assistant narration', ['阶段一', '最终结论'])
  expect(consumedContents).toEqual(['direct user prompt', '阶段一', '最终结论'])
})
```

- [x] **Step 2: Run history tests and verify RED**

Run: `corepack pnpm@11.7.0 exec vitest run packages/dsh-host/test/send-message.test.ts packages/dsh-host/test/native-user-events.test.ts`

Expected: FAIL because no sent-message event is appended or consumed.

- [x] **Step 3: Append and consume the dedicated event**

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'personal-growth/message-sent': { id: string; callId: string; text: string }
  }
}
```

After `sent` or `already_sent`, append this event once by id to `exec.agent.session`. In `consumeStandaloneTurn`, collect these events as assistant conversation entries and, for direct user-owned turns with sent events, ignore ordinary assistant messages so memory records only text that actually reached the delivery exit.

- [x] **Step 4: Run history tests and verify GREEN**

Run: `corepack pnpm@11.7.0 exec vitest run packages/dsh-host/test/send-message.test.ts packages/dsh-host/test/native-user-events.test.ts`

Expected: all selected tests pass.

### Task 4: Wire the tool, enforce background policy, and update prompts

**Files:**
- Modify: `packages/dsh-host/src/plugin.ts`
- Modify: `packages/dsh-host/src/admin/integration.ts`
- Modify: `packages/dsh-host/test/plugin.test.ts`
- Modify: `packages/dsh-host/test/admin-integration.test.ts`
- Modify: `workspace/AGENT.md`
- Modify: `packages/runtime/src/bootstrap.ts`

- [x] **Step 1: Write failing wiring and prompt tests**

```ts
expect(REQUIRED_AGENT_TOOLS).toContain('send_message')
expect(backgroundGuard({ name: 'send_message' })).toBe('hidden_agent_read_only')
expect(deliveryPrompt).toContain('continue')
expect(deliveryPrompt).toContain('not delivered automatically')
```

- [x] **Step 2: Run wiring tests and verify RED**

Run: `corepack pnpm@11.7.0 exec vitest run packages/dsh-host/test/plugin.test.ts packages/dsh-host/test/admin-integration.test.ts`

Expected: FAIL because the tool is not in the required surface and the delivery prompt is not installed.

- [x] **Step 3: Wire the tool and prompt**

```ts
const sendDisposer = registerSendMessageTool(toolRuntime, async input => {
  if (!bridge) throw new Error('send_message is unavailable before the foreground bridge starts')
  return bridge.sendActiveMessage(input)
})

export function installMessageDeliveryPrompt(ctx: Context) {
  ctx.systemPrompt.section({ name: 'deployment:message-delivery', order: 10, text: MESSAGE_DELIVERY_PROMPT })
}
```

Install the immutable delivery section for every foreground Agent setup, add `send_message` to `REQUIRED_AGENT_TOOLS`, retain hidden `restrict/guard`, update the checked-in mission and bootstrap default with the same behavioral contract, and dispose the tool with the other Host tools.

- [x] **Step 4: Run wiring tests and verify GREEN**

Run: `corepack pnpm@11.7.0 exec vitest run packages/dsh-host/test/plugin.test.ts packages/dsh-host/test/admin-integration.test.ts packages/dsh-host/test/critical-gaps.test.ts`

Expected: all selected tests pass.

### Task 5: Verify all acceptance criteria, commit, and push

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `task_plan.md`
- Modify: `findings.md`
- Modify: `progress.md`

- [x] **Step 1: Document the delivery boundary and acceptance mapping**

```md
- `send_message(text)` is the sole foreground user-task delivery exit.
- Tool calls are session-bound; recipients are never model arguments.
- The DSH call id forms the durable idempotency identity.
- Confirmed sent-message events feed conversation history and Memory; hidden Agents remain denied.
```

- [x] **Step 2: Run fresh focused verification**

Run: `corepack pnpm@11.7.0 exec vitest run packages/dsh-host/test packages/qq-adapter/test`

Expected: zero failed tests.

Evidence: the broad Host/QQ/runtime selection passed 23 files / 150 tests excluding the previously timing-out production fixture; after its missing `systemPrompt.section()` seam was fixed, the operator separately ran `production-wake.test.ts` and passed 1 file / 1 test. The split run covers the complete intended selection without a failed test.

- [x] **Step 3: Run repository quality gates**

Run: `corepack pnpm@11.7.0 lint`

Run: `corepack pnpm@11.7.0 typecheck`

Run: `corepack pnpm@11.7.0 build`

Expected: every command exits 0.

- [x] **Step 4: Review the diff and acceptance checklist**

Run: `git diff --check`

Run: `git diff --stat`

Run: `git status --short --branch`

Expected: no whitespace errors; only planned files are modified.

- [x] **Step 5: Commit the verified change**

```powershell
git add packages/dsh-host/src/send-message.ts packages/dsh-host/src/bridge.ts packages/dsh-host/src/plugin.ts packages/dsh-host/src/admin/integration.ts packages/dsh-host/test/send-message.test.ts packages/dsh-host/test/bridge.test.ts packages/dsh-host/test/native-user-events.test.ts packages/dsh-host/test/plugin.test.ts packages/dsh-host/test/admin-integration.test.ts packages/dsh-host/test/critical-gaps.test.ts packages/runtime/src/bootstrap.ts workspace/AGENT.md docs/ARCHITECTURE.md docs/superpowers/plans/2026-09-15-in-turn-multi-message-delivery.md task_plan.md findings.md progress.md
git commit -m "feat: support in-turn message delivery"
```

Expected: one new commit on `codex/host-completion`.

- [x] **Step 6: Push without rewriting history**

Run: `git push origin codex/host-completion`

Expected: `origin/codex/host-completion` advances to the new commit.
