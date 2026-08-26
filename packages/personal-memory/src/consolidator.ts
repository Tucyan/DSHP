import { z } from 'zod';
import { appendJsonl, readJsonl, readJson, writeJsonAtomic } from '@personal-growth/shared';
import { validateWorkspacePaths, workspacePaths, type WorkspacePaths } from './paths.js';
import { assertOperationalPaths, assertWorkspacePath } from './reader.js';
import { withWorkspaceLock } from './lock.js';

/** Hard upper bounds keep persisted sequence arithmetic and history ranges resource-safe. */
export const MAX_CONVERSATION_SEQ = 1_000_000;
export const MAX_HISTORY_RANGE = 100_000;
export const ConversationEventSchema = z.object({ sessionId: z.string().min(1), seq: z.number().int().positive().max(MAX_CONVERSATION_SEQ), role: z.enum(['user', 'assistant']), content: z.string().min(1), at: z.string().datetime({ offset: true }) }).strict();
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;
export const HistoryRecordSchema = z.object({ id: z.string().min(1), sessionId: z.string().min(1), fromSeq: z.number().int().positive().max(MAX_CONVERSATION_SEQ), toSeq: z.number().int().positive().max(MAX_CONVERSATION_SEQ), sourceRefs: z.array(z.string().min(1)).min(1).max(MAX_HISTORY_RANGE), summary: z.string().min(1), at: z.string().datetime({ offset: true }) }).strict().superRefine((record, ctx) => {
  if (record.fromSeq > record.toSeq) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'History range is reversed' });
  if (record.toSeq - record.fromSeq + 1 > MAX_HISTORY_RANGE) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'History range exceeds maximum' });
  const references = record.sourceRefs.map((ref) => { const match = ref.match(/^(.+):(\d+)$/); return match ? { sessionId: match[1], seq: Number(match[2]) } : undefined; });
  const seqs = references.filter((ref): ref is { sessionId: string; seq: number } => Boolean(ref)).map((ref) => ref.seq).sort((a, b) => a - b);
  if (new Set(record.sourceRefs).size !== record.sourceRefs.length || references.some((ref) => !ref || ref.sessionId !== record.sessionId || ref.seq < record.fromSeq || ref.seq > record.toSeq) || seqs.length !== record.toSeq - record.fromSeq + 1 || seqs.some((seq, index) => seq !== record.fromSeq + index) || references.some((ref, index) => !ref || ref.seq !== record.fromSeq + index)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'History sourceRefs do not match session range' });
});
export type HistoryRecord = z.infer<typeof HistoryRecordSchema>;
const StateSchema = z.object({ memoryCursor: z.record(z.string(), z.number().int().nonnegative().max(MAX_CONVERSATION_SEQ)).default({}), pendingMutation: z.unknown().optional() }).strict();
type State = z.infer<typeof StateSchema>;

export interface CompressorPort { compress(events: readonly ConversationEvent[]): string | Promise<string>; }
export interface ConsolidatorOptions { workspace?: string; root?: string; paths?: WorkspacePaths; compressor: CompressorPort; clock?: () => string; manageLock?: boolean; lockTimeoutMs?: number; }

export class CursorConsolidator {
  readonly paths: WorkspacePaths;
  private readonly compressor: CompressorPort;
  private readonly clock: () => string;
  private readonly manageLock: boolean;
  private readonly lockTimeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(options: ConsolidatorOptions) { this.paths = validateWorkspacePaths(options.paths ?? workspacePaths(options.root ?? options.workspace ?? process.cwd())); this.compressor = options.compressor; this.clock = options.clock ?? (() => new Date().toISOString()); this.manageLock = options.manageLock ?? true; this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000; if (this.lockTimeoutMs < 30_000 || !Number.isFinite(this.lockTimeoutMs)) throw new Error('Configured workspace lock timeout must be at least 30000ms'); }

  consume(input: readonly ConversationEvent[]): Promise<HistoryRecord | null> {
    const operation = this.queue.then(() => this.consumeNow(input));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async consumeNow(input: readonly ConversationEvent[]): Promise<HistoryRecord | null> {
    if (input.length > MAX_HISTORY_RANGE) throw new Error(`Conversation batch exceeds maximum ${MAX_HISTORY_RANGE}`);
    const parsed = input.map((event) => ConversationEventSchema.parse(event));
    return this.consumeTwoPhase(parsed, 0);
  }

  private async consumeTwoPhase(input: readonly ConversationEvent[], attempt: number): Promise<HistoryRecord | null> {
    const prepared = await this.withLock(() => this.prepare(input));
    if (!prepared.plans.length && !Object.keys(prepared.cursorAdvances).length) return null;
    const records: HistoryRecord[] = [];
    for (const plan of prepared.plans) {
      const compressed = await this.compressor.compress(plan.events);
      const summary = typeof compressed === 'string' ? compressed : (compressed as unknown as { summary?: string })?.summary;
      if (!summary?.trim()) throw new Error('Compressor returned an empty summary');
      records.push(HistoryRecordSchema.parse({ id: plan.id, sessionId: plan.sessionId, fromSeq: plan.fromSeq, toSeq: plan.toSeq, sourceRefs: plan.events.map((event) => `${event.sessionId}:${event.seq}`), summary: summary.trim(), at: this.clock() }));
    }
    const committed = await this.withLock(() => this.commit(prepared, records));
    if (committed.retry) {
      if (attempt >= 2) throw new Error('Conversation consolidation changed during compression');
      return this.consumeTwoPhase(input, attempt + 1);
    }
    return committed.latest;
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> { return this.manageLock ? withWorkspaceLock(this.paths.root, operation, this.lockTimeoutMs) : operation(); }

  private async prepare(input: readonly ConversationEvent[]): Promise<PreparedConsumption> {
    await assertOperationalPaths(this.paths);
    const parsed = input.map((event) => ConversationEventSchema.parse(event));
    const grouped = new Map<string, ConversationEvent[]>();
    for (const event of parsed) grouped.set(event.sessionId, [...(grouped.get(event.sessionId) ?? []), event]);
    const state = await this.readState();
    const historyResult = await readJsonl(this.paths.history, HistoryRecordSchema);
    if (historyResult.errors.length) throw new Error(`Malformed history.jsonl: ${historyResult.errors.map((error) => error.line).join(',')}`);
    const covered = new Set(historyResult.records.flatMap((record) => record.sourceRefs));
    const coverage = buildCoverage(historyResult.records);
    for (const [sessionId, cursor] of Object.entries(state.memoryCursor)) {
      assertRangeCovered(coverage.get(sessionId) ?? [], 1, cursor, `Persisted cursor has uncovered history gap for ${sessionId}`);
    }
    const plans: ConsumptionPlan[] = []; const cursorAdvances: Record<string, number> = {}; const existingRecords: HistoryRecord[] = [];
    for (const [sessionId, batch] of grouped) {
      for (let i = 1; i < batch.length; i++) if (batch[i].seq <= batch[i - 1].seq) throw new Error(`Non-monotonic conversation sequence for ${sessionId}`);
      const cursor = state.memoryCursor[sessionId] ?? 0;
      const candidates = batch.filter((event) => event.seq > cursor);
      const unseen = candidates.filter((event) => !covered.has(`${event.sessionId}:${event.seq}`));
      const highest = candidates.reduce((max, event) => Math.max(max, event.seq), cursor);
      assertRangeCovered([...(coverage.get(sessionId) ?? []), ...candidates.map((event) => [event.seq, event.seq] as const)], cursor + 1, highest, `Incoming conversation sequence gap for ${sessionId}`);
      if (!unseen.length) { if (highest > cursor) cursorAdvances[sessionId] = highest; continue; }
      const fromSeq = unseen[0].seq;
      const toSeq = unseen[unseen.length - 1].seq;
      const id = `${sessionId}:${fromSeq}-${toSeq}`;
      const existing = historyResult.records.find((record) => record.id === id);
      if (existing) { cursorAdvances[sessionId] = Math.max(cursorAdvances[sessionId] ?? 0, toSeq); existingRecords.push(existing); continue; }
      plans.push({ id, sessionId, fromSeq, toSeq, events: unseen }); cursorAdvances[sessionId] = toSeq;
    }
    return { snapshot: snapshotKey(state, historyResult.records), state, plans, cursorAdvances, existingRecords };
  }

  private async commit(prepared: PreparedConsumption, records: readonly HistoryRecord[]): Promise<{ retry: boolean; latest: HistoryRecord | null }> {
    await assertOperationalPaths(this.paths);
    const state = await this.readState(); const historyResult = await readJsonl(this.paths.history, HistoryRecordSchema);
    if (historyResult.errors.length) throw new Error(`Malformed history.jsonl: ${historyResult.errors.map((error) => error.line).join(',')}`);
    if (snapshotKey(state, historyResult.records) !== prepared.snapshot) return { retry: true, latest: null };
    let latest: HistoryRecord | null = prepared.existingRecords.at(-1) ?? null;
    for (const record of records) {
      const existing = historyResult.records.find((candidate) => candidate.id === record.id);
      if (existing) latest = existing;
      else { await assertWorkspacePath(this.paths, this.paths.history); await appendJsonl(this.paths.history, record); latest = record; }
    }
    for (const [sessionId, cursor] of Object.entries(prepared.cursorAdvances)) state.memoryCursor[sessionId] = Math.max(state.memoryCursor[sessionId] ?? 0, cursor);
    await this.writeState(state);
    return { retry: false, latest };
  }

  private async readState(): Promise<State> {
    await assertOperationalPaths(this.paths);
    try { return StateSchema.parse(await readJson(this.paths.state, StateSchema)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { memoryCursor: {} }; throw error; }
  }
  private async writeState(state: State): Promise<void> { await assertOperationalPaths(this.paths); await writeJsonAtomic(this.paths.state, state); }
}

interface ConsumptionPlan { id: string; sessionId: string; fromSeq: number; toSeq: number; events: readonly ConversationEvent[]; }
interface PreparedConsumption { snapshot: string; state: State; plans: ConsumptionPlan[]; cursorAdvances: Record<string, number>; existingRecords: HistoryRecord[]; }
function snapshotKey(state: State, records: readonly HistoryRecord[]): string { return JSON.stringify({ cursor: state.memoryCursor, history: records.map((record) => [record.id, record.sourceRefs, record.summary]) }); }

type Interval = readonly [number, number];
function buildCoverage(records: readonly HistoryRecord[]): Map<string, Interval[]> {
  const bySession = new Map<string, Interval[]>();
  for (const record of records) bySession.set(record.sessionId, [...(bySession.get(record.sessionId) ?? []), [record.fromSeq, record.toSeq]]);
  for (const [sessionId, ranges] of bySession) bySession.set(sessionId, mergeIntervals(ranges));
  return bySession;
}
function mergeIntervals(ranges: readonly Interval[]): Interval[] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1]); const merged: Array<[number, number]> = [];
  for (const [from, to] of sorted) { const previous = merged.at(-1); if (!previous || from > previous[1] + 1) merged.push([from, to]); else previous[1] = Math.max(previous[1], to); }
  return merged;
}
function assertRangeCovered(ranges: readonly Interval[], from: number, to: number, message: string): void {
  if (from > to) return;
  let next = from;
  for (const [rangeFrom, rangeTo] of mergeIntervals(ranges)) { if (rangeTo < next) continue; if (rangeFrom > next) throw new Error(`${message}: ${next}`); next = Math.max(next, rangeTo + 1); if (next > to) return; }
  if (next <= to) throw new Error(`${message}: ${next}`);
}
