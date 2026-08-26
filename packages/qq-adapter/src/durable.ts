import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '@personal-growth/shared';
import { z } from 'zod';

const BindingSchema = z.object({ peerId: z.string().min(1), context: z.literal('private') }).strict();
const LedgerEntrySchema = z.object({ status: z.enum(['pending', 'sent']), occurrenceId: z.string().min(1) }).strict();
const StateSchema = z.object({ binding: BindingSchema.nullable(), outbound: z.record(LedgerEntrySchema) }).strict();
type State = z.infer<typeof StateSchema>;

function assertInside(filePath: string, runtimeRoot: string): string {
  const root = path.resolve(runtimeRoot); const target = path.resolve(filePath); const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('state path must stay inside runtime root');
  if (path.extname(target).toLowerCase() !== '.json') throw new Error('state path must be a JSON file');
  return target;
}
async function nearestRealPath(value: string): Promise<string> {
  let ancestor = value;
  while (true) {
    try { return await fs.realpath(ancestor); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && path.dirname(ancestor) !== ancestor) { ancestor = path.dirname(ancestor); continue; }
      throw error;
    }
  }
}
async function assertCanonicalInside(target: string, runtimeRoot: string): Promise<void> {
  const root = await nearestRealPath(path.resolve(runtimeRoot));
  const realParent = await nearestRealPath(path.dirname(target));
  const relative = path.relative(root, realParent);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('state path resolves outside runtime root');
  try {
    const targetStat = await fs.lstat(target);
    if (targetStat.isSymbolicLink()) throw new Error('state file must not be a symlink');
    const realTarget = await fs.realpath(target);
    const targetRelative = path.relative(root, realTarget);
    if (targetRelative.startsWith(`..${path.sep}`) || targetRelative === '..' || path.isAbsolute(targetRelative)) throw new Error('state path resolves outside runtime root');
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}

export class QqDurableStateStore {
  private queue = Promise.resolve();
  private constructor(readonly statePath: string, readonly runtimeRoot: string, private state: State) {}
  static async open(statePath: string, runtimeRoot: string): Promise<QqDurableStateStore> {
    const target = assertInside(statePath, runtimeRoot); await assertCanonicalInside(target, runtimeRoot); await fs.mkdir(path.dirname(target), { recursive: true }); await assertCanonicalInside(target, runtimeRoot); let state: State = { binding: null, outbound: {} };
    try { state = StateSchema.parse(JSON.parse(await fs.readFile(target, 'utf8'))); }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
    return new QqDurableStateStore(target, path.resolve(runtimeRoot), state);
  }
  binding(): { peerId: string; context: 'private' } | null { return this.state.binding ? { ...this.state.binding } : null; }
  async bind(peerId: string): Promise<void> { const parsed = BindingSchema.safeParse({ peerId, context: 'private' }); if (!parsed.success) throw new Error('QQ peer binding is invalid'); await this.mutate(() => { if (this.state.binding && this.state.binding.peerId !== peerId) throw new Error('QQ binding is already fixed to another peer'); this.state.binding = parsed.data; }); }
  async claim(key: string, occurrenceId: string): Promise<'claimed' | 'sent'> {
    return this.mutate(() => { const prior = this.state.outbound[key]; if (prior?.status === 'sent') return 'sent'; if (prior?.status === 'pending') throw new QqDurableStateError('OUTBOUND_UNCERTAIN', 'outbound delivery is uncertain because of an unresolved crash ambiguity'); this.state.outbound[key] = { status: 'pending', occurrenceId }; return 'claimed'; });
  }
  async complete(key: string): Promise<void> { await this.mutate(() => { const prior = this.state.outbound[key]; if (!prior || prior.status !== 'pending') throw new QqDurableStateError('OUTBOUND_STATE', 'outbound completion has no pending reservation'); prior.status = 'sent'; }); }
  async fail(key: string): Promise<void> { await this.mutate(() => { if (this.state.outbound[key]?.status === 'pending') delete this.state.outbound[key]; }); }
  async simulatePending(key: string, occurrenceId: string): Promise<void> { await this.mutate(() => { this.state.outbound[key] = { status: 'pending', occurrenceId }; }); }
  private mutate<T>(fn: () => T): Promise<T> { const result = this.queue.then(async () => { await assertCanonicalInside(this.statePath, this.runtimeRoot); const value = fn(); await assertCanonicalInside(this.statePath, this.runtimeRoot); await writeJsonAtomic(this.statePath, this.state); await assertCanonicalInside(this.statePath, this.runtimeRoot); return value; }); this.queue = result.then(() => undefined, () => undefined); return result; }
}

export class QqDurableStateError extends Error { constructor(readonly code: 'OUTBOUND_UNCERTAIN' | 'OUTBOUND_STATE', message: string) { super(message); this.name = 'QqDurableStateError'; } }
