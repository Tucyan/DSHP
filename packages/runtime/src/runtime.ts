import { createHash } from 'node:crypto';
import { appendJsonl, durableJsonTransaction, redactTrace, readJsonl, TraceRecordSchema } from '@personal-growth/shared';
import { AgentCore } from '@personal-growth/agent-core';
import type { AgentAction, AgentTrigger } from '@personal-growth/shared';
import { MemoryService, DreamService, ConversationEventSchema, type ConversationEvent } from '@personal-growth/personal-memory';
import { HeartbeatService, type WakeResult } from '@personal-growth/personal-heartbeat';
import { DshSchedule, LiveDshSchedule, type DshLiveScheduleTool, type DshSchedulePort, type ScheduleBinding, type ScheduleRequest, type PendingScheduleResolution } from '@personal-growth/dsh-adapter';
import { DurableQqPort, type QqInbound, type QqOutbound, type QqTransport, type QqPort } from '@personal-growth/qq-adapter';
import { z } from 'zod';
import { bootstrapRuntime, type BootstrappedRuntime, type BootstrapOptions } from './bootstrap.js';
import { DemoModel } from './demo-model.js';
import { ExtensionWriter } from './extension-writer.js';

const ConversationStateSchema = z.object({ next: z.record(z.string(), z.number().int().nonnegative()) }).strict();
const DispatchStateSchema = z.object({ dispatched: z.record(z.object({ at: z.string(), status: z.enum(['pending', 'completed']) }).strict()) }).strict();

export interface RuntimeOptions extends BootstrapOptions { peerId: string; now?: () => string; model?: DemoModel; }
export interface LiveRuntimeOptions extends RuntimeOptions { transport: QqTransport; inbound: AsyncIterable<QqInbound>; scheduleTool: DshLiveScheduleTool; }
export interface RuntimeSchedulePort extends DshSchedulePort { recover?: (at: string) => Promise<ScheduleBinding[]>; reconcilePending?: (key: string, resolution: PendingScheduleResolution) => Promise<ScheduleBinding | null>; }
export interface ProcessResult { trigger: AgentTrigger; action: AgentAction; }
export interface RuntimeQq extends QqPort { readonly outbox: QqOutbound[]; pushInbound(event: QqInbound): void; close?(): Promise<void>; }

export class PersonalGrowthRuntime {
  readonly paths: BootstrappedRuntime['paths'];
  readonly memory: MemoryService;
  readonly heartbeat: HeartbeatService;
  readonly qq: RuntimeQq;
  readonly schedules: RuntimeSchedulePort;
  readonly extensions: ExtensionWriter;
  private readonly core: AgentCore;
  private readonly dream: DreamService;
  private readonly model: DemoModel;
  private readonly now: () => string;
  private readonly conversationState: string;
  private readonly tracePath: string;
  private readonly mainConversationPath: string;
  private readonly scheduleDispatchState: string;
  private readonly sessionId: string;
  private running = false;

  private constructor(boot: BootstrappedRuntime, options: RuntimeOptions, qq: RuntimeQq, schedules: RuntimeSchedulePort, model: DemoModel) {
    this.paths = boot.paths; this.now = options.now ?? (() => new Date().toISOString()); this.model = model;
    this.sessionId = `qq:${options.peerId}`; this.conversationState = `${this.paths.storage}/conversation-state.json`; this.tracePath = `${this.paths.workspace}/data/traces.jsonl`; this.mainConversationPath = `${this.paths.sessions}/main/conversation.jsonl`; this.scheduleDispatchState = `${this.paths.storage}/schedule-dispatch.json`;
    this.qq = qq; this.schedules = schedules; this.extensions = new ExtensionWriter(this.paths.agentsHome, this.paths.root, this.tracePath);
    this.memory = new MemoryService({ workspace: this.paths.workspace, clock: this.now, compressor: model, actor: 'personal-growth-runtime' });
    this.dream = new DreamService(model);
    const contextSource = {
      getSoul: async () => readText(`${this.paths.workspace}/SOUL.md`), getMission: async () => readText(`${this.paths.workspace}/AGENT.md`),
      getProfile: async () => this.memory.readProfile(), getRelevantMemories: async () => [],
      getSessionDelta: async () => '', getCurrentGoal: async () => undefined,
    };
    const trace = { write: async (record: unknown) => appendJsonl(this.tracePath, redactTrace(record)) };
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
    const boot = await bootstrapRuntime(options); const model = options.model ?? new DemoModel();
    const config = { peerId: options.peerId, appId: 'live', appSecretEnv: 'QQBOT_SECRET', bindingPath: `${boot.paths.storage}/qq-binding.json` };
    const qq = new LiveQqRuntimePort(new DurableQqPort(config, options.transport, `${boot.paths.storage}/qq-binding.json`, boot.paths.root, options.now, options.inbound));
    const schedules = await LiveDshSchedule.open(options.scheduleTool, `qq:${options.peerId}`, `${boot.paths.storage}/schedules.json`, boot.paths.root);
    return new PersonalGrowthRuntime(boot, options, qq, schedules, model);
  }

  async processNext(): Promise<ProcessResult | null> {
    const trigger = await this.qq.receive(); if (!trigger) return null; const action = await this.core.handle(trigger);
    if (trigger.type === 'user_message') {
      const user: ConversationEvent = { sessionId: trigger.sessionId, seq: await this.nextSeq(trigger.sessionId), role: 'user', content: trigger.text, at: trigger.at };
      const assistant: ConversationEvent = { sessionId: trigger.sessionId, seq: await this.nextSeq(trigger.sessionId), role: 'assistant', content: action.type === 'RESPOND' ? action.text : action.type, at: trigger.at };
      await appendJsonl(this.mainConversationPath, ConversationEventSchema.parse(user)); await appendJsonl(this.mainConversationPath, ConversationEventSchema.parse(assistant));
      const history = await this.memory.consume([user, assistant]);
      if (history) { const proposals = await this.dream.dream({ newHistory: [history], profile: await this.memory.readProfile(), index: await this.memory.readIndex(), relevantMemories: [] }); for (const proposal of proposals) await this.applyDream(proposal); }
    }
    return { trigger, action };
  }
  async start(): Promise<void> { this.running = true; while (this.running) { const result = await this.processNext(); if (!result) break; } }
  stop(): void { this.running = false; void this.qq.close?.(); }
  async runBackground(occurrenceId: string): Promise<WakeResult> { return this.heartbeat.wakeBackground({ occurrenceId, at: this.now() }); }
  async runForeground(occurrenceId: string, importance: 'low' | 'normal' | 'high' = 'normal'): Promise<WakeResult> { return this.heartbeat.wakeForeground({ occurrenceId, at: this.now(), importance }); }
  async schedule(request: ScheduleRequest & { idempotencyKey?: string }): Promise<ScheduleBinding> { const { idempotencyKey, ...schedule } = request; return this.schedules.create(schedule, idempotencyKey); }
  async scheduleList(): Promise<ScheduleBinding[]> { return this.schedules.list(this.sessionId); }
  async deleteSchedule(id: string): Promise<boolean> { return this.schedules.delete(id); }
  async recoverSchedules(at = this.now()): Promise<ScheduleBinding[]> { return this.schedules.recover ? this.schedules.recover(at) : []; }
  async reconcileSchedulePending(idempotencyKey: string, resolution: PendingScheduleResolution): Promise<ScheduleBinding | null> { if (!this.schedules.reconcilePending) throw new Error('schedule adapter does not expose pending reconciliation'); return this.schedules.reconcilePending(idempotencyKey, resolution); }
  async reconcileQqPending(idempotencyKey: string, outcome: 'sent' | 'not_sent'): Promise<void> { const reconcile = (this.qq as RuntimeQq & { reconcilePending?: (key: string, outcome: 'sent' | 'not_sent') => Promise<void> }).reconcilePending; if (!reconcile) throw new Error('QQ adapter does not expose pending reconciliation'); await reconcile.call(this.qq, idempotencyKey, outcome); }
  async dispatchDue(at = this.now()): Promise<ProcessResult[]> {
    if (this.schedules.recover) await this.schedules.recover(at);
    const bindings = await this.schedules.list(this.sessionId); const results: ProcessResult[] = []; const nowEpoch = Date.parse(at);
    for (const binding of bindings) {
      if (binding.status === 'pending') continue;
      const firstDue = Date.parse(binding.at) <= nowEpoch;
      if (!firstDue) continue;
      const key = binding.kind === 'interval' ? `schedule:${binding.id}:interval` : `schedule:${binding.id}:${binding.at}`;
      const claimed = await durableJsonTransaction(this.scheduleDispatchState, this.paths.root, DispatchStateSchema, { dispatched: {} }, (state) => {
        const previous = state.dispatched[key];
        if (previous?.status === 'completed' && binding.kind === 'interval' && nowEpoch - Date.parse(previous.at) < (binding.everySeconds ?? 300) * 1000) return false;
        if (previous?.status === 'completed' && binding.kind === 'once') return false;
        state.dispatched[key] = { at, status: 'pending' }; return true;
      });
      if (!claimed.result) continue;
      const trigger: AgentTrigger = { type: 'schedule', scheduleId: binding.id, prompt: binding.prompt, at }; results.push({ trigger, action: await this.core.handle(trigger) });
      await durableJsonTransaction(this.scheduleDispatchState, this.paths.root, DispatchStateSchema, { dispatched: {} }, (state) => { const current = state.dispatched[key]; if (current?.status === 'pending') current.status = 'completed'; });
    }
    return results;
  }
  async queryTrace(limit = 100): Promise<unknown[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('trace query limit must be between 1 and 100');
    const parsed = await readJsonl(this.tracePath, TraceRecordSchema); if (parsed.errors.length) throw new Error('trace store is malformed');
    return parsed.records.slice(-limit).map((record) => { const serialized = JSON.stringify(record); if (/content|secret|token|password|credential|authorization/i.test(serialized)) throw new Error('trace contains forbidden raw data'); return redactTrace(record); });
  }
  async queryMainConversation(): Promise<string> { return readText(this.mainConversationPath); }
  private async deliver(text: string, trigger: AgentTrigger, background: boolean): Promise<void> { if (background) throw new Error('background delivery is prohibited'); const key = `message:${trigger.type}:${'occurrenceId' in trigger ? trigger.occurrenceId : trigger.at}:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`; await this.qq.send({ occurrenceId: 'occurrenceId' in trigger ? trigger.occurrenceId : key, idempotencyKey: key, text, background: false }); }
  private async nextSeq(sessionId: string): Promise<number> { const transaction = await durableJsonTransaction(this.conversationState, this.paths.root, ConversationStateSchema, { next: {} }, (state) => { state.next[sessionId] = (state.next[sessionId] ?? 0) + 1; return state.next[sessionId]; }); return transaction.result; }
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
  async send(message: QqOutbound): Promise<boolean> { const sent = await this.official.send(message); if (sent) this.outbox.push({ ...message }); return sent; }
  close(): Promise<void> { return this.official.close(); }
}
async function readText(filePath: string): Promise<string> { try { return await (await import('node:fs/promises')).readFile(filePath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }
