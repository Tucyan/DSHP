import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendJsonl, durableJsonTransaction, redactTrace, readJsonl, TraceRecordSchema, AgentActionSchema } from '@personal-growth/shared';
import { AgentCore, type StructuredModelPort } from '@personal-growth/agent-core';
import type { AgentAction, AgentTrigger } from '@personal-growth/shared';
import { MemoryService, DreamService, ConversationEventSchema, type ConversationEvent } from '@personal-growth/personal-memory';
import { HeartbeatService, type WakeResult } from '@personal-growth/personal-heartbeat';
import { DshSchedule, LiveDshSchedule, type DshLiveScheduleTool, type DshSchedulePort, type ScheduleBinding, type ScheduleRequest, type PendingScheduleResolution } from '@personal-growth/dsh-adapter';
import { DurableQqPort, type QqInbound, type QqOutbound, type QqTransport, type QqPort } from '@personal-growth/qq-adapter';
import { z } from 'zod';
import { bootstrapRuntime, type BootstrappedRuntime, type BootstrapOptions } from './bootstrap.js';
import { DemoModel } from './demo-model.js';
import { ExtensionWriter } from './extension-writer.js';

const ProcessingEntrySchema = z.object({ messageId: z.string().min(1), sessionId: z.string().min(1), text: z.string().min(1), at: z.string().min(1), userSeq: z.number().int().positive(), assistantSeq: z.number().int().positive(), status: z.enum(['pending', 'completed']), action: AgentActionSchema.optional() }).strict();
const ConversationStateSchema = z.object({ next: z.record(z.string(), z.number().int().nonnegative()), entries: z.record(ProcessingEntrySchema).default({}) }).strict();
const DispatchStateSchema = z.object({ dispatched: z.record(z.object({ at: z.string(), status: z.enum(['pending', 'completed']), owner: z.string().optional(), leaseUntil: z.string().optional(), action: AgentActionSchema.optional() }).strict()) }).strict();
const RuntimeTraceEvents = new Set(['action.accepted', 'action.rejected', 'qq.inbound', 'qq.outbound', 'memory.consolidate', 'memory.apply', 'heartbeat.foreground', 'heartbeat.background', 'schedule.dispatch', 'skill.created', 'plugin.proposed']);
type DeliveryScope = { messageId?: string; stableKey?: string; effects: Array<{ text: string; trigger: AgentTrigger; stableKey?: string }> };

export interface GoalContextPort { getCurrentGoal(trigger: AgentTrigger): string | undefined | Promise<string | undefined>; }
export interface RuntimeModel extends StructuredModelPort { compress?(events: readonly { content: string }[]): string | Promise<string>; propose?(input: { newHistory: readonly unknown[]; profile: string; index: string; relevantMemories: readonly string[] }): unknown[] | Promise<unknown[]>; }
export interface RuntimeOptions extends BootstrapOptions { peerId: string; now?: () => string; model?: RuntimeModel; goalPort?: GoalContextPort; }
export interface WorkerOptions { cadenceMs?: number; maxTicks?: number; keepAlive?: boolean; runImmediately?: boolean; wait?: (milliseconds: number) => Promise<void>; foreground?: () => Promise<unknown>; background?: () => Promise<unknown>; dispatch?: () => Promise<unknown>; }
export interface LiveRuntimeOptions extends RuntimeOptions { model: RuntimeModel; goalPort: GoalContextPort; transport: QqTransport; inbound: AsyncIterable<QqInbound>; scheduleTool: DshLiveScheduleTool; }
export interface RuntimeSchedulePort extends DshSchedulePort { recover?: (at: string) => Promise<ScheduleBinding[]>; reconcilePending?: (key: string, resolution: PendingScheduleResolution) => Promise<ScheduleBinding | null>; }
export interface ProcessResult { trigger: AgentTrigger; action: AgentAction; }
export interface RuntimeInboundEnvelope { trigger: AgentTrigger; messageId: string; }
export interface RuntimeQq extends QqPort { readonly outbox: QqOutbound[]; pushInbound(event: QqInbound): void; close?(): Promise<void>; receiveEnvelope?(): Promise<RuntimeInboundEnvelope | null>; claimInbound?(messageId: string): Promise<'claimed' | 'completed' | 'pending'>; renewInbound?(messageId: string): Promise<void>; completeInbound?(messageId: string): Promise<void>; failInbound?(messageId: string): Promise<void>; }

export class PersonalGrowthRuntime {
  readonly paths: BootstrappedRuntime['paths'];
  readonly memory: MemoryService;
  readonly heartbeat: HeartbeatService;
  readonly qq: RuntimeQq;
  readonly schedules: RuntimeSchedulePort;
  readonly extensions: ExtensionWriter;
  private readonly core: AgentCore;
  private readonly dream: DreamService;
  private readonly model: RuntimeModel;
  private readonly now: () => string;
  private readonly conversationState: string;
  private readonly tracePath: string;
  private readonly mainConversationPath: string;
  private readonly scheduleDispatchState: string;
  private readonly sessionId: string;
  private processQueue: Promise<unknown> = Promise.resolve();
  private readonly dispatchOwner = randomUUID();
  private readonly deliveryScopes = new AsyncLocalStorage<DeliveryScope>();
  private running = false;

  private constructor(boot: BootstrappedRuntime, options: RuntimeOptions, qq: RuntimeQq, schedules: RuntimeSchedulePort, model: RuntimeModel) {
    this.paths = boot.paths; this.now = options.now ?? (() => new Date().toISOString()); this.model = model;
    this.sessionId = `qq:${options.peerId}`; this.conversationState = `${this.paths.storage}/conversation-state.json`; this.tracePath = `${this.paths.workspace}/data/traces.jsonl`; this.mainConversationPath = `${this.paths.sessions}/main/conversation.jsonl`; this.scheduleDispatchState = `${this.paths.storage}/schedule-dispatch.json`;
    this.qq = qq; this.schedules = schedules; this.extensions = new ExtensionWriter(this.paths.agentsHome, this.paths.root, this.tracePath);
    const compressor = { compress: (events: readonly ConversationEvent[]) => model.compress?.(events) ?? events.map((event) => event.content).join('；').slice(0, 2000) };
    this.memory = new MemoryService({ workspace: this.paths.workspace, clock: this.now, compressor, actor: 'personal-growth-runtime' });
    this.dream = new DreamService({ propose: (input) => model.propose?.(input) ?? [] });
    const contextSource = {
      getSoul: async () => readText(`${this.paths.workspace}/SOUL.md`), getMission: async () => readText(`${this.paths.workspace}/AGENT.md`),
      getProfile: async () => this.memory.readProfile(), getRelevantMemories: async (trigger: AgentTrigger) => this.relevantMemories(trigger),
      getSessionDelta: async (trigger: AgentTrigger) => this.sessionDelta(trigger), getCurrentGoal: async (trigger: AgentTrigger) => options.goalPort?.getCurrentGoal(trigger),
    };
    const trace = { write: async (record: unknown) => this.writeTrace(record) };
    this.core = new AgentCore({ contextSource, model, trace,
      response: { deliver: (text, trigger) => this.deliver(text, trigger, false) },
      userMessage: { deliver: (message, trigger) => this.deliver(message.text, trigger, false) },
      skillWriter: { write: (skill, trigger) => this.extensions.createSkill({ name: skill.name, description: 'Use when the user requests a repeatable workflow.', instructions: `${skill.instructions}\n\nInput: user request. Output: completed workflow. Stop when output is delivered.`, positiveTriggers: ['explicit skill request'], negativeTriggers: ['unrelated request'] }, trigger.at).then(() => undefined) },
      pluginWriter: { write: (proposal, trigger) => this.extensions.proposePlugin(proposal, trigger.at).then(() => undefined) },
      reflection: { write: (reflection, trigger) => appendJsonl(`${this.paths.sessions}/background/${trigger.type}-${'occurrenceId' in trigger ? trigger.occurrenceId : 'reflection'}.jsonl`, { at: trigger.at, actionType: 'REFLECT', summary: reflection.summary }) },
    });
    this.heartbeat = new HeartbeatService({ workspace: this.paths.workspace, core: this.core, clock: this.now, config: { timeZone: 'UTC', quietHours: { start: '00:00', end: '00:00' }, cooldownMinutes: 120, maxContactsPerDay: 4 }, sink: { append: async (record) => appendJsonl(`${this.paths.sessions}/background/${record.occurrenceId}.jsonl`, redactTrace(record)) } });
  }

  static async open(options: RuntimeOptions): Promise<PersonalGrowthRuntime> {
    const boot = await bootstrapRuntime(options); const model = options.model ?? new DemoModel();
    const outbox: QqOutbound[] = []; const transport: QqTransport = { sendPrivate: async (_peerId, text) => { outbox.push({ occurrenceId: 'qq', idempotencyKey: createHash('sha256').update(`${outbox.length}:${text}`).digest('hex'), text, background: false }); } };
    const config = { peerId: options.peerId, appId: 'local-demo', appSecretEnv: 'PERSONAL_GROWTH_QQ_SECRET', bindingPath: `${boot.paths.storage}/qq-binding.json` };
    const durable = new DurableQqPort(config, transport, `${boot.paths.storage}/qq-binding.json`, boot.paths.root, options.now);
    const qq = durable as unknown as RuntimeQq; Object.defineProperty(qq, 'outbox', { get: () => outbox });
    const schedules = await DshSchedule.open(`${boot.paths.storage}/schedules.json`, boot.paths.root);
    return new PersonalGrowthRuntime(boot, options, qq, schedules, model);
  }

  static async openLive(options: LiveRuntimeOptions): Promise<PersonalGrowthRuntime> {
    const boot = await bootstrapRuntime(options); const model = options.model;
    const config = { peerId: options.peerId, appId: 'live', appSecretEnv: 'QQBOT_SECRET', bindingPath: `${boot.paths.storage}/qq-binding.json` };
    const qq = new LiveQqRuntimePort(new DurableQqPort(config, options.transport, `${boot.paths.storage}/qq-binding.json`, boot.paths.root, options.now, options.inbound));
    const schedules = await LiveDshSchedule.open(options.scheduleTool, `qq:${options.peerId}`, `${boot.paths.storage}/schedules.json`, boot.paths.root);
    return new PersonalGrowthRuntime(boot, options, qq, schedules, model);
  }

  async processNext(): Promise<ProcessResult | null> { const operation = this.processQueue.then(() => this.processNextNow()); this.processQueue = operation.then(() => undefined, () => undefined); return operation; }
  private async processNextNow(): Promise<ProcessResult | null> {
    while (true) {
      const envelope = this.qq.receiveEnvelope ? await this.qq.receiveEnvelope() : await this.qq.receive().then((trigger) => trigger ? { trigger, messageId: `legacy:${createHash('sha256').update(JSON.stringify(trigger)).digest('hex')}` } : null);
      if (!envelope) return null;
      if (this.qq.claimInbound && await this.qq.claimInbound(envelope.messageId) !== 'claimed') continue;
      await this.traceEvent('qq.inbound', { messageId: envelope.messageId, status: 'claimed' });
      const trigger = envelope.trigger; const userTrigger = trigger.type === 'user_message' ? trigger : undefined; const entry = userTrigger ? await this.reserveProcessing(envelope.messageId, userTrigger) : undefined;
      const user = entry && userTrigger ? { sessionId: userTrigger.sessionId, seq: entry.userSeq, role: 'user' as const, content: userTrigger.text, at: userTrigger.at } satisfies ConversationEvent : undefined;
      if (entry) {
        await this.appendConversationOnce(user!);
      }
      let action: AgentAction;
      let effects: Array<{ text: string; trigger: AgentTrigger; stableKey?: string }> = [];
      if (entry?.action) action = entry.action;
      else {
        const scope: DeliveryScope = { messageId: envelope.messageId, effects: [] };
        const renewal = this.startLeaseRenewal(() => this.qq.renewInbound?.(envelope.messageId));
        try { action = await this.deliveryScopes.run(scope, () => this.core.handle(trigger)); effects = scope.effects; }
        finally { clearInterval(renewal); }
        if (entry) await this.recordProcessingAction(envelope.messageId, action);
      }
      if (userTrigger) {
        const assistant: ConversationEvent = { sessionId: userTrigger.sessionId, seq: entry!.assistantSeq, role: 'assistant', content: action.type === 'RESPOND' ? action.text : action.type, at: userTrigger.at };
        await this.appendConversationOnce(assistant);
        const history = await this.memory.consume([user!, assistant]);
        if (history) { await this.traceEvent('memory.consolidate', { sessionId: userTrigger.sessionId, fromSeq: history.fromSeq, toSeq: history.toSeq }); const proposals = await this.dream.dream({ newHistory: [history], profile: await this.memory.readProfile(), index: await this.memory.readIndex(), relevantMemories: [] }); for (const proposal of proposals) { await this.applyDream(proposal); await this.traceEvent('memory.apply', { action: proposal.action, path: proposal.path }); } }
        if (!effects.length && (action.type === 'RESPOND' || action.type === 'MESSAGE_USER')) effects = [{ text: action.text, trigger, stableKey: envelope.messageId }];
        await this.flushDeliveries(effects);
        await this.completeProcessing(envelope.messageId, action); if (this.qq.completeInbound) await this.qq.completeInbound(envelope.messageId);
      } else {
        await this.flushDeliveries(effects);
      }
      return { trigger, action };
    }
  }
  async start(options: WorkerOptions = {}): Promise<void> {
    this.running = true;
    const workerEnabled = options.maxTicks !== undefined || options.cadenceMs !== undefined || options.foreground || options.background || options.dispatch;
    const inboundLoop = async () => { while (this.running) { const result = await this.processNext(); if (!result) break; } if (workerEnabled && options.keepAlive === false) this.running = false; };
    if (!workerEnabled) { await inboundLoop(); return; }
    const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const foreground = options.foreground ?? (() => this.runForeground(`worker-foreground-${this.now()}`, 'low'));
    const background = options.background ?? (() => this.runBackground(`worker-background-${this.now()}`));
    const dispatch = options.dispatch ?? (() => this.dispatchDue());
    const workerLoop = async () => { let ticks = 0; if (options.runImmediately === false && (options.cadenceMs ?? 1000) > 0) await wait(options.cadenceMs ?? 1000); while (this.running && (options.maxTicks === undefined || ticks < options.maxTicks)) { await Promise.all([foreground(), background(), dispatch()]); ticks += 1; if (this.running && (options.maxTicks === undefined || ticks < options.maxTicks) && (options.cadenceMs ?? 1000) > 0) await wait(options.cadenceMs ?? 1000); } };
    await Promise.all([inboundLoop(), workerLoop()]); this.running = false;
  }
  stop(): void { this.running = false; void this.qq.close?.(); }
  async runBackground(occurrenceId: string): Promise<WakeResult> { const result = await this.heartbeat.wakeBackground({ occurrenceId, at: this.now() }); await this.traceEvent('heartbeat.background', { occurrenceId, status: result.status }); return result; }
  async runForeground(occurrenceId: string, importance: 'low' | 'normal' | 'high' = 'normal'): Promise<WakeResult> { const result = await this.heartbeat.wakeForeground({ occurrenceId, at: this.now(), importance }); await this.traceEvent('heartbeat.foreground', { occurrenceId, status: result.status }); return result; }
  async schedule(request: ScheduleRequest & { idempotencyKey?: string }): Promise<ScheduleBinding> { const { idempotencyKey, ...schedule } = request; return this.schedules.create(schedule, idempotencyKey); }
  async scheduleList(): Promise<ScheduleBinding[]> { return this.schedules.list(this.sessionId); }
  async deleteSchedule(id: string): Promise<boolean> { return this.schedules.delete(id); }
  async recoverSchedules(at = this.now()): Promise<ScheduleBinding[]> { return this.schedules.recover ? this.schedules.recover(at) : []; }
  async reconcileSchedulePending(idempotencyKey: string, resolution: PendingScheduleResolution): Promise<ScheduleBinding | null> { if (!this.schedules.reconcilePending) throw new Error('schedule adapter does not expose pending reconciliation'); return this.schedules.reconcilePending(idempotencyKey, resolution); }
  async reconcileQqPending(idempotencyKey: string, outcome: 'sent' | 'not_sent'): Promise<void> { const reconcile = (this.qq as RuntimeQq & { reconcilePending?: (key: string, outcome: 'sent' | 'not_sent') => Promise<void> }).reconcilePending; if (!reconcile) throw new Error('QQ adapter does not expose pending reconciliation'); await reconcile.call(this.qq, idempotencyKey, outcome); }
  async reconcileQqInbound(messageId: string, outcome: 'retry' | 'completed'): Promise<void> { if (outcome === 'completed') { if (!this.qq.completeInbound) throw new Error('QQ adapter does not expose inbound reconciliation'); await this.qq.completeInbound(messageId); return; } if (!this.qq.failInbound) throw new Error('QQ adapter does not expose inbound reconciliation'); await this.qq.failInbound(messageId); }
  async dispatchDue(at = this.now()): Promise<ProcessResult[]> {
    if (this.schedules.recover) await this.schedules.recover(at);
    const bindings = await this.schedules.list(this.sessionId); const results: ProcessResult[] = []; const nowEpoch = Date.parse(at);
    for (const binding of bindings) {
      if (binding.status === 'pending') continue;
      const firstDue = Date.parse(binding.at) <= nowEpoch;
      if (!firstDue) continue;
      const claimed = await durableJsonTransaction(this.scheduleDispatchState, this.paths.root, DispatchStateSchema, { dispatched: {} }, (state) => {
        const nowEpoch = Date.parse(at);
        const prefix = `schedule:${binding.id}:`;
        const previous = Object.entries(state.dispatched).filter(([candidate]) => candidate.startsWith(prefix)).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))[0]?.[1];
        const occurrenceEpoch = binding.kind === 'interval' && previous ? Date.parse(previous.at) + (binding.everySeconds ?? 300) * 1000 : Date.parse(binding.at);
        const key = `${prefix}${new Date(occurrenceEpoch).toISOString()}`;
        if (occurrenceEpoch > nowEpoch) return { claimed: false as const, key };
        const current = state.dispatched[key];
        if (current?.status === 'pending' && current.leaseUntil && Date.parse(current.leaseUntil) > nowEpoch) return { claimed: false as const, key };
        if (current?.status === 'completed') return { claimed: false as const, key };
        state.dispatched[key] = { at: new Date(occurrenceEpoch).toISOString(), status: 'pending', owner: this.dispatchOwner, leaseUntil: new Date(nowEpoch + 30_000).toISOString(), action: current?.action }; return { claimed: true as const, key };
      });
      if (!claimed.result.claimed) continue;
      const key = claimed.result.key;
      const trigger: AgentTrigger = { type: 'schedule', scheduleId: binding.id, prompt: binding.prompt, at };
      const current = claimed.state.dispatched[key]; let action: AgentAction; let effects: Array<{ text: string; trigger: AgentTrigger; stableKey?: string }> = [];
      if (current?.action) action = current.action;
      else {
        const scope: DeliveryScope = { stableKey: key, effects: [] };
        const renewal = this.startLeaseRenewal(() => this.renewDispatchLease(key));
        try {
          action = await this.deliveryScopes.run(scope, () => this.core.handle(trigger)); effects = scope.effects;
          await durableJsonTransaction(this.scheduleDispatchState, this.paths.root, DispatchStateSchema, { dispatched: {} }, (state) => { const record = state.dispatched[key]; if (!record || record.owner !== this.dispatchOwner) throw new Error('schedule dispatch ownership lost'); record.action = AgentActionSchema.parse(action); });
        } catch (error) {
          await durableJsonTransaction(this.scheduleDispatchState, this.paths.root, DispatchStateSchema, { dispatched: {} }, (state) => { const record = state.dispatched[key]; if (record?.owner === this.dispatchOwner && record.status === 'pending') delete state.dispatched[key]; });
          throw error;
        } finally { clearInterval(renewal); }
      }
      if (!effects.length && (action.type === 'RESPOND' || action.type === 'MESSAGE_USER')) effects = [{ text: action.text, trigger, stableKey: key }];
      await this.flushDeliveries(effects); results.push({ trigger, action }); await this.traceEvent('schedule.dispatch', { scheduleId: binding.id, status: 'completed' });
      await durableJsonTransaction(this.scheduleDispatchState, this.paths.root, DispatchStateSchema, { dispatched: {} }, (state) => { const record = state.dispatched[key]; if (!record || record.owner !== this.dispatchOwner) throw new Error('schedule dispatch ownership lost'); record.status = 'completed'; record.leaseUntil = undefined; });
    }
    return results;
  }
  async queryTrace(limit = 100): Promise<unknown[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('trace query limit must be between 1 and 100');
    const parsed = await readJsonl(this.tracePath, TraceRecordSchema); if (parsed.errors.length) throw new Error('trace store is malformed');
    return parsed.records.slice(-limit).map((record) => { if (!RuntimeTraceEvents.has(record.event) || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) throw new Error('trace contains an unsupported event or payload'); const data = record.data as Record<string, unknown>; if (Object.keys(data).some((key) => /content|text|secret|token|password|credential|authorization/i.test(key))) throw new Error('trace contains forbidden raw data'); return { at: record.at, event: record.event, data: redactTrace(data) }; });
  }
  private async relevantMemories(trigger: AgentTrigger): Promise<readonly string[]> {
    const heartbeatQuery = 'long-term goals recent progress support priorities';
    const query = trigger.type === 'user_message' ? trigger.text : trigger.type === 'schedule' ? trigger.prompt : heartbeatQuery;
    const profile = trigger.type === 'user_message' || trigger.type === 'schedule' ? '' : await this.memory.readProfile();
    const matches = await this.memory.search(query.trim().slice(0, 200), 5);
    const values = matches.map((entry) => entry.raw.slice(0, 4000));
    if (profile.trim()) values.unshift(profile.slice(0, 4000));
    return values;
  }
  private async sessionDelta(trigger: AgentTrigger): Promise<string | undefined> {
    const sessionId = trigger.type === 'user_message' ? trigger.sessionId : this.sessionId;
    const records = await readJsonl(this.mainConversationPath, ConversationEventSchema);
    if (records.errors.length) throw new Error('main conversation is malformed');
    const recent = records.records.filter((record) => record.sessionId === sessionId).slice(-6);
    return recent.length ? recent.map((record) => `${record.role}: ${record.content.slice(0, 500)}`).join('\n') : undefined;
  }
  async queryMainConversation(): Promise<string> { return readText(this.mainConversationPath); }
  private async deliver(text: string, trigger: AgentTrigger, background: boolean): Promise<void> { if (background) throw new Error('background delivery is prohibited'); const scope = this.deliveryScopes.getStore(); if (scope) { scope.effects.push({ text, trigger, stableKey: scope.messageId ?? scope.stableKey }); return; } await this.sendDelivery(text, trigger); }
  private async sendDelivery(text: string, trigger: AgentTrigger, stableKey?: string): Promise<void> { const stable = stableKey ?? ('occurrenceId' in trigger ? trigger.occurrenceId : undefined); const key = stable ? `message:${trigger.type}:${stable}` : `message:${trigger.type}:${trigger.at}:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`; await this.qq.send({ occurrenceId: stable ?? key, idempotencyKey: key, text, background: false }); await this.traceEvent('qq.outbound', { idempotencyKey: key, status: 'sent' }); }
  private async flushDeliveries(effects: Array<{ text: string; trigger: AgentTrigger; stableKey?: string }>): Promise<void> { for (const effect of effects) await this.sendDelivery(effect.text, effect.trigger, effect.stableKey); }
  private startLeaseRenewal(renew: () => Promise<void> | undefined): ReturnType<typeof setInterval> { return setInterval(() => { void renew()?.catch(() => undefined); }, 10_000); }
  private async renewDispatchLease(key: string): Promise<void> { await durableJsonTransaction(this.scheduleDispatchState, this.paths.root, DispatchStateSchema, { dispatched: {} }, (state) => { const record = state.dispatched[key]; if (!record || record.owner !== this.dispatchOwner || record.status !== 'pending') throw new Error('schedule dispatch lease is no longer owned'); record.leaseUntil = new Date(Date.parse(this.now()) + 30_000).toISOString(); }); }
  private async reserveProcessing(messageId: string, trigger: Extract<AgentTrigger, { type: 'user_message' }>): Promise<z.infer<typeof ProcessingEntrySchema>> { const transaction = await durableJsonTransaction(this.conversationState, this.paths.root, ConversationStateSchema, { next: {}, entries: {} }, (state) => { const entries = state.entries ?? (state.entries = {}); const existing = entries[messageId]; if (existing) return existing; const next = state.next[trigger.sessionId] ?? 0; const entry = { messageId, sessionId: trigger.sessionId, text: trigger.text, at: trigger.at, userSeq: next + 1, assistantSeq: next + 2, status: 'pending' as const }; state.next[trigger.sessionId] = next + 2; entries[messageId] = entry; return entry; }); return transaction.result; }
  private async completeProcessing(messageId: string, action: AgentAction): Promise<void> { await durableJsonTransaction(this.conversationState, this.paths.root, ConversationStateSchema, { next: {}, entries: {} }, (state) => { const entry = state.entries?.[messageId]; if (!entry) throw new Error('conversation processing journal entry missing'); entry.action = AgentActionSchema.parse(action); entry.status = 'completed'; }); }
  private async recordProcessingAction(messageId: string, action: AgentAction): Promise<void> { await durableJsonTransaction(this.conversationState, this.paths.root, ConversationStateSchema, { next: {}, entries: {} }, (state) => { const entry = state.entries?.[messageId]; if (!entry) throw new Error('conversation processing journal entry missing'); entry.action = AgentActionSchema.parse(action); }); }
  private async appendConversationOnce(event: ConversationEvent): Promise<void> { const existing = await readJsonl(this.mainConversationPath, ConversationEventSchema); if (existing.errors.length) throw new Error('main conversation is malformed'); const found = existing.records.find((candidate) => candidate.sessionId === event.sessionId && candidate.seq === event.seq); if (found) { if (found.role !== event.role || found.content !== event.content) throw new Error('conversation journal conflict'); return; } await appendJsonl(this.mainConversationPath, event); }
  private async traceEvent(event: string, data: Record<string, unknown>): Promise<void> { await this.writeTrace({ at: this.now(), event, data }); }
  private async writeTrace(record: unknown): Promise<void> { if (!record || typeof record !== 'object') throw new Error('trace record must be an object'); const value = record as { at?: unknown; event?: unknown; data?: unknown }; if (typeof value.at !== 'string' || typeof value.event !== 'string' || !RuntimeTraceEvents.has(value.event) || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw new Error('trace record is outside runtime allowlist'); const data = value.data as Record<string, unknown>; if (Object.keys(data).some((key) => /content|text|secret|token|password|credential|authorization/i.test(key))) throw new Error('trace data contains forbidden fields'); await appendJsonl(this.tracePath, redactTrace({ at: value.at, event: value.event, data })); }
  private async applyDream(proposal: Parameters<MemoryService['apply']>[0]): Promise<void> {
    try { await this.memory.apply(proposal); }
    catch (error) {
      if (!(error instanceof Error) || !/already exists/i.test(error.message) || proposal.action !== 'CREATE') throw error;
      const current = await this.memory.read(proposal.path);
      await this.memory.apply({ ...proposal, action: 'UPDATE', expectedHash: current.hash });
    }
  }
}

export async function createRuntime(options: RuntimeOptions): Promise<PersonalGrowthRuntime> { return PersonalGrowthRuntime.open(options); }
export async function createLiveRuntime(options: LiveRuntimeOptions): Promise<PersonalGrowthRuntime> { return PersonalGrowthRuntime.openLive(options); }
class LiveQqRuntimePort implements RuntimeQq {
  readonly outbox: QqOutbound[] = [];
  constructor(private readonly official: DurableQqPort) {}
  pushInbound(event: QqInbound): void { void event; throw new Error('live QQ inbound is owned by the official Tencent stream'); }
  receive(): Promise<AgentTrigger | null> { return this.official.receive(); }
  async receiveEnvelope(): Promise<RuntimeInboundEnvelope | null> { const envelope = await this.official.receiveEnvelope(); return envelope; }
  claimInbound(messageId: string): Promise<'claimed' | 'completed' | 'pending'> { return this.official.claimInbound(messageId); }
  renewInbound(messageId: string): Promise<void> { return this.official.renewInbound(messageId); }
  failInbound(messageId: string): Promise<void> { return this.official.failInbound(messageId); }
  completeInbound(messageId: string): Promise<void> { return this.official.completeInbound(messageId); }
  reconcilePending(key: string, outcome: 'sent' | 'not_sent'): Promise<void> { return this.official.reconcilePending(key, outcome); }
  async send(message: QqOutbound): Promise<boolean> { const sent = await this.official.send(message); if (sent) this.outbox.push({ ...message }); return sent; }
  close(): Promise<void> { return this.official.close(); }
}
async function readText(filePath: string): Promise<string> { try { return await (await import('node:fs/promises')).readFile(filePath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }
