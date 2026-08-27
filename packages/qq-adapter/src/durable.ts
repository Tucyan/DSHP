import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { durableJsonRead, durableJsonTransaction } from '@personal-growth/shared';
import { z } from 'zod';

const BindingSchema = z.object({ peerId: z.string().min(1), context: z.literal('private') }).strict();
const LedgerEntrySchema = z.object({ status: z.enum(['pending', 'sent']), occurrenceId: z.string().min(1) }).strict();
const InboundEntrySchema = z.object({ status: z.enum(['pending', 'completed']), owner: z.string().optional(), leaseUntil: z.string().optional() }).strict();
const StateSchema = z.object({ binding: BindingSchema.nullable(), outbound: z.record(LedgerEntrySchema), inbound: z.record(InboundEntrySchema) }).strict();
type State = z.infer<typeof StateSchema>;

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
    return this.mutate((state) => { const prior = state.outbound[key]; if (prior?.status === 'sent') return 'sent'; if (prior?.status === 'pending') throw new QqDurableStateError('OUTBOUND_UNCERTAIN', 'outbound delivery is uncertain because of an unresolved crash ambiguity'); state.outbound[key] = { status: 'pending', occurrenceId }; return 'claimed'; });
  }
  async claimInbound(messageId: string): Promise<'claimed' | 'completed' | 'pending'> { return this.mutate((state) => { const prior = state.inbound[messageId]; if (prior?.status === 'completed') return 'completed'; const now = Date.parse(this.clock()); if (prior?.status === 'pending' && prior.owner !== this.owner && prior.leaseUntil && Date.parse(prior.leaseUntil) > now) return 'pending'; state.inbound[messageId] = { status: 'pending', owner: this.owner, leaseUntil: new Date(now + 30_000).toISOString() }; return 'claimed'; }); }
  async renewInbound(messageId: string): Promise<void> { await this.mutate((state) => { const prior = state.inbound[messageId]; if (!prior || prior.status !== 'pending' || prior.owner !== this.owner) throw new QqDurableStateError('INBOUND_STATE', 'inbound lease is not owned by this runtime'); prior.leaseUntil = new Date(Date.parse(this.clock()) + 30_000).toISOString(); }); }
  async completeInbound(messageId: string): Promise<void> { await this.mutate((state) => { const prior = state.inbound[messageId]; if (prior?.status === 'pending' && prior.owner !== this.owner) throw new QqDurableStateError('INBOUND_STATE', 'inbound completion is not owned by this runtime'); state.inbound[messageId] = { status: 'completed' }; }); }
  async failInbound(messageId: string): Promise<void> { await this.mutate((state) => { if (state.inbound[messageId]?.status === 'pending') delete state.inbound[messageId]; }); }
  async complete(key: string): Promise<void> { await this.mutate((state) => { const prior = state.outbound[key]; if (!prior || prior.status !== 'pending') throw new QqDurableStateError('OUTBOUND_STATE', 'outbound completion has no pending reservation'); prior.status = 'sent'; }); }
  async fail(key: string): Promise<void> { await this.mutate((state) => { if (state.outbound[key]?.status === 'pending') delete state.outbound[key]; }); }
  async reconcile(key: string, outcome: 'sent' | 'not_sent'): Promise<void> { if (outcome === 'sent') return this.complete(key); await this.fail(key); }
  async simulatePending(key: string, occurrenceId: string): Promise<void> { await this.mutate((state) => { state.outbound[key] = { status: 'pending', occurrenceId }; }); }
  private mutate<T>(fn: (state: State) => T): Promise<T> { const result = this.queue.then(async () => { const transaction = await durableJsonTransaction(this.statePath, this.runtimeRoot, StateSchema, { binding: null, outbound: {}, inbound: {} }, fn); this.state = transaction.state; return transaction.result; }); this.queue = result.then(() => undefined, () => undefined); return result; }
}

export class QqDurableStateError extends Error { constructor(readonly code: 'OUTBOUND_UNCERTAIN' | 'OUTBOUND_STATE' | 'INBOUND_STATE', message: string) { super(message); this.name = 'QqDurableStateError'; } }
