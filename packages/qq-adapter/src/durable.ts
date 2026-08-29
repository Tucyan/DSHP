import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { durableJsonRead, durableJsonTransaction } from '@personal-growth/shared';
import { z } from 'zod';

const TimestampSchema = z.string().datetime({ offset: true }).refine((value) => { const epoch = Date.parse(value); return Number.isFinite(epoch) && epoch >= Date.UTC(2000, 0, 1) && epoch <= Date.UTC(2100, 0, 1); }, 'timestamp is outside supported range');
const MessageIdSchema = z.string().min(1).max(256).refine((value) => !hasControlCharacter(value), 'messageId contains a control character');
const InboundTriggerSchema = z.object({ type: z.literal('user_message'), sessionId: z.string().min(1).max(256), text: z.string().min(1).max(4096), at: TimestampSchema }).strict();
export type DurableInboundTrigger = z.infer<typeof InboundTriggerSchema>;
export interface DurableInboundEnvelope { messageId: string; trigger: DurableInboundTrigger; }
const BindingSchema = z.object({ peerId: z.string().min(1).max(256), context: z.literal('private') }).strict();
const LedgerEntrySchema = z.object({ status: z.enum(['pending', 'sent']), occurrenceId: MessageIdSchema }).strict();
const InboundEntrySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('queued'), trigger: InboundTriggerSchema }).strict(),
  z.object({ status: z.literal('pending'), owner: z.string().min(1).max(256), leaseUntil: TimestampSchema, trigger: InboundTriggerSchema }).strict(),
  z.object({ status: z.literal('completed'), completedAt: TimestampSchema, trigger: InboundTriggerSchema }).strict(),
]);
const StateSchema = z.object({ binding: BindingSchema.nullable(), outbound: z.record(LedgerEntrySchema).refine((value) => Object.keys(value).length <= 10_000, 'outbound ledger is too large'), inbound: z.record(InboundEntrySchema).refine((value) => Object.keys(value).length <= 10_000, 'inbound ledger is too large') }).strict();
type State = z.infer<typeof StateSchema>;
function checkedTimestamp(value: string): string { return TimestampSchema.parse(value); }
function checkedMessageId(value: string): string { return MessageIdSchema.parse(value); }
function hasControlCharacter(value: string): boolean { for (const character of value) { const code = character.charCodeAt(0); if (code < 32 || code === 127) return true; } return false; }
function pruneCompleted(state: State, limit: number): void {
  const inboundCompleted = Object.entries(state.inbound).flatMap(([messageId, record]) => record.status === 'completed' ? [[messageId, record] as const] : []).sort(([, a], [, b]) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  const inboundExcess = Math.max(0, Object.keys(state.inbound).length - limit);
  for (const [messageId] of inboundCompleted.slice(0, inboundExcess)) delete state.inbound[messageId];
  const sentKeys = Object.entries(state.outbound).filter(([, record]) => record.status === 'sent');
  const outboundExcess = Math.max(0, Object.keys(state.outbound).length - limit);
  for (const [key] of sentKeys.slice(0, outboundExcess)) delete state.outbound[key];
}

function assertInside(filePath: string, runtimeRoot: string): string {
  const root = path.resolve(runtimeRoot); const target = path.resolve(filePath); const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('state path must stay inside runtime root');
  if (path.extname(target).toLowerCase() !== '.json') throw new Error('state path must be a JSON file');
  return target;
}
export class QqDurableStateStore {
  private queue = Promise.resolve();
  private readonly owner = randomUUID();
  private constructor(readonly statePath: string, readonly runtimeRoot: string, private state: State, private readonly clock: () => string) {}
  static async open(statePath: string, runtimeRoot: string, clock: () => string = () => new Date().toISOString()): Promise<QqDurableStateStore> {
    const target = assertInside(statePath, runtimeRoot); let state;
    try { state = await durableJsonRead(target, runtimeRoot, StateSchema, { binding: null, outbound: {}, inbound: {} }); }
    catch (error) {
      // One-way migration for the pre-inbound-ledger state. Any other malformed
      // state remains fail-closed instead of guessing ownership.
      try { const legacy = JSON.parse(await readFile(target, 'utf8')) as { binding?: unknown; outbound?: unknown; inbound?: unknown }; if (legacy && legacy.inbound === undefined && legacy.binding !== undefined && legacy.outbound !== undefined) state = StateSchema.parse({ binding: legacy.binding, outbound: legacy.outbound, inbound: {} }); else throw error; }
      catch (migrationError) { if (migrationError === error) throw error; throw migrationError; }
    }
    return new QqDurableStateStore(target, path.resolve(runtimeRoot), state, clock);
  }
  binding(): { peerId: string; context: 'private' } | null { return this.state.binding ? { ...this.state.binding } : null; }
  async bind(peerId: string): Promise<void> { const parsed = BindingSchema.safeParse({ peerId, context: 'private' }); if (!parsed.success) throw new Error('QQ peer binding is invalid'); await this.mutate((state) => { if (state.binding && state.binding.peerId !== peerId) throw new Error('QQ binding is already fixed to another peer'); state.binding = parsed.data; }); }
  async claim(key: string, occurrenceId: string): Promise<'claimed' | 'sent'> {
    checkedMessageId(key); checkedMessageId(occurrenceId);
    return this.mutate((state) => { const prior = state.outbound[key]; if (prior?.status === 'sent') return 'sent'; if (prior?.status === 'pending') throw new QqDurableStateError('OUTBOUND_UNCERTAIN', 'outbound delivery is uncertain because of an unresolved crash ambiguity'); state.outbound[key] = { status: 'pending', occurrenceId }; return 'claimed'; });
  }
  async enqueueInbound(messageId: string, trigger: DurableInboundTrigger): Promise<'queued' | 'pending' | 'completed'> {
    checkedMessageId(messageId); const parsed = InboundTriggerSchema.parse(trigger);
    return this.mutate((state) => { const prior = state.inbound[messageId]; if (prior) { if (JSON.stringify(prior.trigger) !== JSON.stringify(parsed)) throw new QqDurableStateError('INBOUND_STATE', 'inbound message payload conflicts with its durable record'); return prior.status; } state.inbound[messageId] = { status: 'queued', trigger: parsed }; return 'queued'; });
  }
  async claimNextInbound(): Promise<DurableInboundEnvelope | null> {
    return this.mutate((state) => { const now = Date.parse(checkedTimestamp(this.clock()));
      for (const [messageId, record] of Object.entries(state.inbound)) {
        if (record.status === 'completed') continue;
        if (record.status === 'queued') { state.inbound[messageId] = { status: 'pending', owner: this.owner, leaseUntil: new Date(now + 30_000).toISOString(), trigger: record.trigger }; return { messageId, trigger: record.trigger }; }
        if (record.owner === this.owner || Date.parse(record.leaseUntil) <= now) { state.inbound[messageId] = { status: 'pending', owner: this.owner, leaseUntil: new Date(now + 30_000).toISOString(), trigger: record.trigger }; return { messageId, trigger: record.trigger }; }
      }
      return null;
    });
  }
  async inboundRetryAfterMs(): Promise<number | undefined> {
    return this.mutate((state) => { const now = Date.parse(checkedTimestamp(this.clock())); const waits = Object.values(state.inbound).filter((record): record is Extract<State['inbound'][string], { status: 'pending' }> => record.status === 'pending' && record.owner !== this.owner && Date.parse(record.leaseUntil) > now).map((record) => Date.parse(record.leaseUntil) - now); return waits.length ? Math.max(1, Math.min(...waits)) : undefined; });
  }
  async claimInbound(messageId: string): Promise<'claimed' | 'completed' | 'pending'> { checkedMessageId(messageId); return this.mutate((state) => { const prior = state.inbound[messageId]; if (!prior) return 'pending'; if (prior.status === 'completed') return 'completed'; const now = Date.parse(checkedTimestamp(this.clock())); if (prior.status === 'queued') { state.inbound[messageId] = { status: 'pending', owner: this.owner, leaseUntil: new Date(now + 30_000).toISOString(), trigger: prior.trigger }; return 'claimed'; } if (prior.owner !== this.owner && Date.parse(prior.leaseUntil) > now) return 'pending'; state.inbound[messageId] = { status: 'pending', owner: this.owner, leaseUntil: new Date(now + 30_000).toISOString(), trigger: prior.trigger }; return 'claimed'; }); }
  async renewInbound(messageId: string): Promise<void> { checkedMessageId(messageId); await this.mutate((state) => { const prior = state.inbound[messageId]; if (!prior || prior.status !== 'pending' || prior.owner !== this.owner) throw new QqDurableStateError('INBOUND_STATE', 'inbound lease is not owned by this runtime'); const now = Date.parse(checkedTimestamp(this.clock())); prior.leaseUntil = new Date(now + 30_000).toISOString(); }); }
  async completeInbound(messageId: string): Promise<void> { checkedMessageId(messageId); await this.mutate((state) => { const prior = state.inbound[messageId]; if (!prior || prior.status !== 'pending' || prior.owner !== this.owner) throw new QqDurableStateError('INBOUND_STATE', 'inbound completion is not owned by this runtime'); state.inbound[messageId] = { status: 'completed', completedAt: checkedTimestamp(this.clock()), trigger: prior.trigger }; }); }
  async failInbound(messageId: string): Promise<void> { checkedMessageId(messageId); await this.mutate((state) => { const prior = state.inbound[messageId]; if (!prior || prior.status === 'completed' || prior.status === 'queued') return; if (prior.owner !== this.owner) throw new QqDurableStateError('INBOUND_STATE', 'inbound failure is not owned by this runtime'); state.inbound[messageId] = { status: 'queued', trigger: prior.trigger }; }); }
  async complete(key: string): Promise<void> { await this.mutate((state) => { const prior = state.outbound[key]; if (!prior || prior.status !== 'pending') throw new QqDurableStateError('OUTBOUND_STATE', 'outbound completion has no pending reservation'); prior.status = 'sent'; }); }
  async fail(key: string): Promise<void> { await this.mutate((state) => { if (state.outbound[key]?.status === 'pending') delete state.outbound[key]; }); }
  async reconcile(key: string, outcome: 'sent' | 'not_sent'): Promise<void> { if (outcome === 'sent') return this.complete(key); await this.fail(key); }
  async simulatePending(key: string, occurrenceId: string): Promise<void> { await this.mutate((state) => { state.outbound[key] = { status: 'pending', occurrenceId }; }); }
  private mutate<T>(fn: (state: State) => T): Promise<T> { const result = this.queue.then(async () => { const transaction = await durableJsonTransaction(this.statePath, this.runtimeRoot, StateSchema, { binding: null, outbound: {}, inbound: {} }, async (state) => { const value = await fn(state); pruneCompleted(state, 10_000); return value; }); this.state = transaction.state; return transaction.result; }); this.queue = result.then(() => undefined, () => undefined); return result; }
}

export class QqDurableStateError extends Error { constructor(readonly code: 'OUTBOUND_UNCERTAIN' | 'OUTBOUND_STATE' | 'INBOUND_STATE', message: string) { super(message); this.name = 'QqDurableStateError'; } }
