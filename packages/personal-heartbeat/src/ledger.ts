import { randomUUID } from 'node:crypto';
import { constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from '@personal-growth/shared';
import { ContactRecordSchema, ContactReservationSchema, Rfc3339InstantSchema, type ContactReservation } from './contact-policy.js';

const SafeActionType = z.enum(['NOOP', 'MESSAGE_USER', 'RESPOND', 'CREATE_SKILL', 'PROPOSE_PLUGIN', 'REFLECT']);
export type SafeActionType = z.infer<typeof SafeActionType>;
const SafeErrorCode = z.enum(['core_error', 'invalid_action', 'policy_violation', 'sink_error', 'state_error', 'invalid_state', 'state_corrupt', 'unknown_error']);
export const LockOwnerSchema = z.object({ token: z.string().uuid(), pid: z.number().int().positive(), createdAt: z.number().finite().nonnegative() }).strict();
export type LockOwner = z.infer<typeof LockOwnerSchema>;
const OccurrenceCommon = { occurrenceId: z.string().min(1).max(256), mode: z.enum(['foreground', 'background']), claimedAt: Rfc3339InstantSchema };
export const OccurrenceSchema = z.discriminatedUnion('status', [
  z.object({ ...OccurrenceCommon, status: z.literal('claimed') }).strict(),
  z.object({ ...OccurrenceCommon, status: z.literal('completed'), completedAt: Rfc3339InstantSchema, actionType: SafeActionType, policyCode: z.enum(['quiet_hours', 'cooldown', 'daily_cap', 'allowed']).optional() }).strict(),
  z.object({ ...OccurrenceCommon, status: z.literal('failed'), failedAt: Rfc3339InstantSchema, errorCode: SafeErrorCode }).strict(),
]);
export type Occurrence = z.infer<typeof OccurrenceSchema>;
export const HeartbeatStateSchema = z.object({ version: z.literal(1), occurrences: z.record(z.string(), OccurrenceSchema), contacts: z.array(ContactRecordSchema).max(2000), reservations: z.array(ContactReservationSchema).max(2000) }).strict().superRefine((state, ctx) => {
  for (const [key, occurrence] of Object.entries(state.occurrences)) {
    if (key !== occurrence.occurrenceId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['occurrences', key], message: 'Occurrence key must match occurrenceId' });
  }
});
export type HeartbeatState = z.infer<typeof HeartbeatStateSchema>;
export type SafeErrorCode = z.infer<typeof SafeErrorCode>;

export interface HeartbeatPaths { root: string; data: string; state: string; lock: string; }
export interface LedgerTiming { monotonicNow: () => number; delay: (milliseconds: number) => Promise<void>; }
export interface LedgerLockOptions extends Partial<LedgerTiming> { staleGraceMs?: number; isProcessAlive?: (pid: number) => boolean | Promise<boolean>; }
export interface HeartbeatLedgerTransaction {
  readonly state: HeartbeatState;
  save(): Promise<void>;
  claim(occurrenceId: string, mode: Occurrence['mode'], at: string): { duplicate: boolean; occurrence?: Occurrence };
  complete(occurrenceId: string, at: string, actionType: SafeActionType, policyCode?: 'quiet_hours' | 'cooldown' | 'daily_cap' | 'allowed'): void;
  fail(occurrenceId: string, at: string, errorCode: SafeErrorCode): void;
  recordContact(record: z.infer<typeof ContactRecordSchema>): void;
  reserveContact(reservation: ContactReservation, currentLocalDay: string): void;
  finalizeContact(occurrenceId: string, actionType: SafeActionType, at: string, importance?: 'low' | 'normal' | 'high'): void;
  markContactUncertain(occurrenceId: string): void;
}

function assertNoSymlinkComponents(path: string, allowMissing = true): void {
  let current = resolve(path); const initial = current;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlinked heartbeat path is not allowed: ${current}`);
      // realpath catches junctions on Windows for existing components.
      const canonical = realpathSync(current);
      if (resolve(canonical) !== current) throw new Error(`Non-canonical heartbeat path is not allowed: ${current}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!allowMissing && current === initial) throw new Error(`Heartbeat workspace does not exist: ${initial}`);
      const parent = resolve(current, '..'); if (parent === current) return; current = parent;
    }
  }
}

// Synchronous checks keep construction side-effect free; async operations re-check before writing.

export function heartbeatPaths(workspaceInput: string): HeartbeatPaths {
  if (!isAbsolute(workspaceInput)) throw new Error('Heartbeat workspace must be an absolute canonical path');
  const root = resolve(workspaceInput); if (root !== workspaceInput) throw new Error('Heartbeat workspace must be canonical');
  assertNoSymlinkComponents(root, false);
  const data = join(root, 'data'); const state = join(data, 'heartbeat-state.json'); const lock = join(data, '.heartbeat.lock');
  assertNoSymlinkComponents(data); assertNoSymlinkComponents(state); assertNoSymlinkComponents(lock);
  return { root, data, state, lock };
}

export function emptyHeartbeatState(): HeartbeatState { return { version: 1, occurrences: {}, contacts: [], reservations: [] }; }

class StateCorruptError extends Error { readonly code = 'state_corrupt'; constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = 'StateCorruptError'; } }
export { StateCorruptError };

function assertOperationalPaths(paths: HeartbeatPaths): void {
  assertNoSymlinkComponents(paths.root, false); assertNoSymlinkComponents(paths.data); assertNoSymlinkComponents(paths.state); assertNoSymlinkComponents(paths.lock);
}
async function readOwnerAt(paths: HeartbeatPaths, ownerPath = paths.lock): Promise<LockOwner> {
  assertNoSymlinkComponents(ownerPath);
  const raw = await readFile(ownerPath, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed || (trimmed.startsWith('{') && !trimmed.endsWith('}'))) { const error = new Error('Heartbeat lock owner metadata is transiently incomplete'); (error as { code?: string }).code = 'LOCK_TRANSIENT'; throw error; }
  let value: unknown; try { value = JSON.parse(raw); } catch (error) { throw new Error('Heartbeat lock owner metadata is malformed; manual recovery required', { cause: error }); }
  const parsed = LockOwnerSchema.safeParse(value);
  if (!parsed.success) throw new Error('Heartbeat lock owner metadata is malformed; manual recovery required');
  return parsed.data;
}
async function removeIfOwnerMatches(paths: HeartbeatPaths, token: string): Promise<boolean> {
  if (!existsSync(paths.lock)) return true;
  const tombstone = `${paths.lock}.${token}.tombstone`; assertNoSymlinkComponents(tombstone);
  try { await rename(paths.lock, tombstone); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  let owner: LockOwner;
  try { owner = await readOwnerAt(paths, tombstone); } catch { if (!existsSync(paths.lock)) await rename(tombstone, paths.lock).catch(() => undefined); return false; }
  if (owner.token === token) { await unlink(tombstone).catch(() => undefined); return true; }
  // A replacement owner was captured: restore it when the canonical path is free,
  // and leave the tombstone untouched rather than deleting another owner's lock.
  if (!existsSync(paths.lock)) await rename(tombstone, paths.lock).catch(() => undefined);
  return false;
}
async function withLock<T>(paths: HeartbeatPaths, operation: () => Promise<T>, timeoutMs: number, timing: LedgerTiming, staleGraceMs: number, isProcessAlive: (pid: number) => boolean | Promise<boolean>): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Heartbeat lock timeout must be between 1ms and 30000ms');
  if (!Number.isFinite(staleGraceMs) || staleGraceMs < 0) throw new Error('Heartbeat stale lock grace must be nonnegative and finite');
  assertOperationalPaths(paths);
  await mkdir(paths.data, { recursive: true });
  assertOperationalPaths(paths);
  const started = checkedMonotonicNow(timing); const owner: LockOwner = { token: randomUUID(), pid: process.pid, createdAt: started }; let acquired = false;
  while (!acquired) {
    try {
      assertOperationalPaths(paths); assertNoSymlinkComponents(paths.lock);
      const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
      let handle;
      try { handle = await open(paths.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600); }
      catch (error) {
        // Some Windows Node builds do not expose O_NOFOLLOW; O_EXCL still
        // protects creation, while the canonical/symlink checks remain fail-closed.
        if (noFollow && (error as NodeJS.ErrnoException).code === 'EINVAL') handle = await open(paths.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        else throw error;
      }
      try { await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      acquired = true;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A contender may observe EEXIST just as the prior owner releases the
      // directory. In that narrow race there is no owner to inspect; retry.
      if (!existsSync(paths.lock)) continue;
      let existing: LockOwner;
      try { existing = await readOwnerAt(paths); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        if ((error as { code?: string }).code === 'LOCK_TRANSIENT') { if (checkedMonotonicNow(timing) - started < Math.min(250, timeoutMs)) { await timing.delay(5); continue; } }
        throw error;
      }
      const age = checkedMonotonicNow(timing) - existing.createdAt;
      if (age >= staleGraceMs) {
        const alive = await isProcessAlive(existing.pid);
        if (alive === false) { await removeIfOwnerMatches(paths, existing.token); continue; }
        throw new Error('Heartbeat lock is live or ownership cannot be proven dead; manual recovery required');
      }
      if (checkedMonotonicNow(timing) - started >= timeoutMs) throw new Error('Heartbeat workspace lock timeout');
      await timing.delay(5);
    }
  }
  try { return await operation(); } finally { await removeIfOwnerMatches(paths, owner.token); }
}
function checkedMonotonicNow(timing: LedgerTiming): number {
  const value = timing.monotonicNow();
  if (!Number.isFinite(value) || value < 0) throw new Error('Injected monotonic clock must return a finite nonnegative number');
  return value;
}

export class HeartbeatLedger {
  readonly paths: HeartbeatPaths;
  readonly lockTimeoutMs: number;
  readonly timing: LedgerTiming;
  readonly staleGraceMs: number;
  readonly isProcessAlive: (pid: number) => boolean | Promise<boolean>;
  constructor(workspace: string, lockTimeoutMs = 30_000, timing?: LedgerLockOptions) {
    this.paths = heartbeatPaths(workspace); this.lockTimeoutMs = lockTimeoutMs;
    this.timing = { monotonicNow: timing?.monotonicNow ?? (() => Number(process.hrtime.bigint()) / 1_000_000), delay: timing?.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))) };
    this.staleGraceMs = timing?.staleGraceMs ?? 30_000; this.isProcessAlive = timing?.isProcessAlive ?? (() => true);
  }
  async read(): Promise<HeartbeatState> {
    try { assertOperationalPaths(this.paths); const state = await readJson(this.paths.state, HeartbeatStateSchema); assertOperationalPaths(this.paths); return state; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyHeartbeatState(); if (error instanceof StateCorruptError) throw error; throw new StateCorruptError('Heartbeat state is malformed or unsafe; manual recovery required', { cause: error }); }
  }
  async transact<T>(operation: (transaction: HeartbeatLedgerTransaction) => Promise<T> | T): Promise<T> {
    return withLock(this.paths, async () => operation(new LedgerTransaction(await this.read(), this.paths)), this.lockTimeoutMs, this.timing, this.staleGraceMs, this.isProcessAlive);
  }
  async claim(occurrenceId: string, mode: Occurrence['mode'], at: string): Promise<{ duplicate: boolean; occurrence?: Occurrence }> {
    return this.transact(async (transaction) => { const result = transaction.claim(occurrenceId, mode, at); if (!result.duplicate) await transaction.save(); return result; });
  }
  async complete(occurrenceId: string, at: string, actionType: SafeActionType, policyCode?: 'quiet_hours' | 'cooldown' | 'daily_cap' | 'allowed'): Promise<void> {
    await this.transact(async (transaction) => { transaction.complete(occurrenceId, at, actionType, policyCode); await transaction.save(); });
  }
  async fail(occurrenceId: string, at: string, errorCode: SafeErrorCode): Promise<void> {
    await this.transact(async (transaction) => { transaction.fail(occurrenceId, at, errorCode); await transaction.save(); });
  }
  async recordContact(record: z.infer<typeof ContactRecordSchema>): Promise<void> {
    await this.transact(async (transaction) => { transaction.recordContact(record); await transaction.save(); });
  }
}

class LedgerTransaction implements HeartbeatLedgerTransaction {
  constructor(readonly state: HeartbeatState, private readonly paths: HeartbeatPaths) {}
  async save(): Promise<void> { assertOperationalPaths(this.paths); await writeJsonAtomic(this.paths.state, HeartbeatStateSchema.parse(this.state)); assertOperationalPaths(this.paths); }
  claim(occurrenceId: string, mode: Occurrence['mode'], at: string): { duplicate: boolean; occurrence?: Occurrence } {
    const hasExisting = Object.prototype.hasOwnProperty.call(this.state.occurrences, occurrenceId); const existing = hasExisting ? this.state.occurrences[occurrenceId] : undefined;
    if (existing) return { duplicate: true, occurrence: existing };
    Object.defineProperty(this.state.occurrences, occurrenceId, { value: { occurrenceId, mode, status: 'claimed', claimedAt: at }, enumerable: true, configurable: true, writable: true });
    return { duplicate: false };
  }
  complete(occurrenceId: string, at: string, actionType: SafeActionType, policyCode?: 'quiet_hours' | 'cooldown' | 'daily_cap' | 'allowed'): void {
    const item = this.state.occurrences[occurrenceId]; if (!item || item.status !== 'claimed' || !actionType) return;
    this.state.occurrences[occurrenceId] = { occurrenceId, mode: item.mode, status: 'completed', claimedAt: item.claimedAt, completedAt: at, actionType, ...(policyCode ? { policyCode } : {}) };
  }
  fail(occurrenceId: string, at: string, errorCode: SafeErrorCode): void {
    const item = this.state.occurrences[occurrenceId]; if (!item || item.status !== 'claimed') return;
    this.state.occurrences[occurrenceId] = { occurrenceId, mode: item.mode, status: 'failed', claimedAt: item.claimedAt, failedAt: at, errorCode };
  }
  recordContact(record: z.infer<typeof ContactRecordSchema>): void {
    this.state.contacts.push(ContactRecordSchema.parse(record)); if (this.state.contacts.length > 2000) this.state.contacts.splice(0, this.state.contacts.length - 2000);
  }
  reserveContact(reservation: ContactReservation, currentLocalDay: string): void {
    this.state.reservations = this.state.reservations.filter((item) => item.localDay >= currentLocalDay && item.occurrenceId !== reservation.occurrenceId);
    this.state.reservations.push(ContactReservationSchema.parse(reservation));
    if (this.state.reservations.length > 2000) this.state.reservations.splice(0, this.state.reservations.length - 2000);
  }
  finalizeContact(occurrenceId: string, actionType: SafeActionType, at: string, importance?: 'low' | 'normal' | 'high'): void {
    this.state.reservations = this.state.reservations.filter((item) => item.occurrenceId !== occurrenceId);
    if (actionType === 'MESSAGE_USER') this.recordContact({ occurrenceId, at, actionType, importance: importance ?? 'normal' });
  }
  markContactUncertain(occurrenceId: string): void {
    const reservation = this.state.reservations.find((item) => item.occurrenceId === occurrenceId); if (reservation) reservation.status = 'uncertain';
  }
}
