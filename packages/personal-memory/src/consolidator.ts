import { z } from 'zod';
import { appendJsonl, readJsonl, readJson, writeJsonAtomic } from '@personal-growth/shared';
import { workspacePaths, type WorkspacePaths } from './paths.js';
import { withWorkspaceLock } from './lock.js';

export const ConversationEventSchema = z.object({ sessionId: z.string().min(1), seq: z.number().int().positive(), role: z.enum(['user', 'assistant']), content: z.string().min(1), at: z.string().datetime({ offset: true }) }).strict();
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;
export const HistoryRecordSchema = z.object({ id: z.string().min(1), sessionId: z.string().min(1), fromSeq: z.number().int().positive(), toSeq: z.number().int().positive(), sourceRefs: z.array(z.string().min(1)).min(1), summary: z.string().min(1), at: z.string().datetime({ offset: true }) }).strict().superRefine((record, ctx) => {
  if (record.fromSeq > record.toSeq) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'History range is reversed' });
  const references = record.sourceRefs.map((ref) => { const match = ref.match(/^(.+):(\d+)$/); return match ? { sessionId: match[1], seq: Number(match[2]) } : undefined; });
  if (new Set(record.sourceRefs).size !== record.sourceRefs.length || references.some((ref) => !ref || ref.sessionId !== record.sessionId || ref.seq < record.fromSeq || ref.seq > record.toSeq)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'History sourceRefs do not match session range' });
});
export type HistoryRecord = z.infer<typeof HistoryRecordSchema>;
const StateSchema = z.object({ memoryCursor: z.record(z.string(), z.number().int().nonnegative()).default({}), pendingMutation: z.unknown().optional() }).strict();
type State = z.infer<typeof StateSchema>;

export interface CompressorPort { compress(events: readonly ConversationEvent[]): string | Promise<string>; }
export interface ConsolidatorOptions { workspace?: string; root?: string; paths?: WorkspacePaths; compressor: CompressorPort; clock?: () => string; manageLock?: boolean; }

export class CursorConsolidator {
  readonly paths: WorkspacePaths;
  private readonly compressor: CompressorPort;
  private readonly clock: () => string;
  private readonly manageLock: boolean;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(options: ConsolidatorOptions) { this.paths = options.paths ?? workspacePaths(options.root ?? options.workspace ?? process.cwd()); this.compressor = options.compressor; this.clock = options.clock ?? (() => new Date().toISOString()); this.manageLock = options.manageLock ?? true; }

  consume(input: readonly ConversationEvent[]): Promise<HistoryRecord | null> {
    const operation = this.queue.then(() => this.consumeNow(input));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private consumeNow(input: readonly ConversationEvent[]): Promise<HistoryRecord | null> { return this.manageLock ? withWorkspaceLock(this.paths.root, () => this.consumeUnlocked(input)) : this.consumeUnlocked(input); }

  private async consumeUnlocked(input: readonly ConversationEvent[]): Promise<HistoryRecord | null> {
    const parsed = input.map((event) => ConversationEventSchema.parse(event));
    const grouped = new Map<string, ConversationEvent[]>();
    for (const event of parsed) grouped.set(event.sessionId, [...(grouped.get(event.sessionId) ?? []), event]);
    const state = await this.readState();
    const historyResult = await readJsonl(this.paths.history, HistoryRecordSchema);
    if (historyResult.errors.length) throw new Error(`Malformed history.jsonl: ${historyResult.errors.map((error) => error.line).join(',')}`);
    const covered = new Set(historyResult.records.flatMap((record) => record.sourceRefs));
    let latest: HistoryRecord | null = null;
    for (const [sessionId, batch] of grouped) {
      for (let i = 1; i < batch.length; i++) if (batch[i].seq <= batch[i - 1].seq) throw new Error(`Non-monotonic conversation sequence for ${sessionId}`);
      const cursor = state.memoryCursor[sessionId] ?? 0;
      const candidates = batch.filter((event) => event.seq > cursor);
      const unseen = candidates.filter((event) => !covered.has(`${event.sessionId}:${event.seq}`));
      const highest = candidates.reduce((max, event) => Math.max(max, event.seq), cursor);
      if (!unseen.length) { if (highest > cursor) { state.memoryCursor[sessionId] = highest; await this.writeState(state); } continue; }
      const fromSeq = unseen[0].seq;
      const toSeq = unseen[unseen.length - 1].seq;
      const id = `${sessionId}:${fromSeq}-${toSeq}`;
      const existing = historyResult.records.find((record) => record.id === id);
      if (existing) { state.memoryCursor[sessionId] = Math.max(state.memoryCursor[sessionId] ?? 0, toSeq); await this.writeState(state); latest = existing; continue; }
      const compressed = await this.compressor.compress(unseen);
      const summary = typeof compressed === 'string' ? compressed : (compressed as unknown as { summary?: string })?.summary;
      if (!summary?.trim()) throw new Error('Compressor returned an empty summary');
      const sourceRefs = unseen.map((event) => `${event.sessionId}:${event.seq}`);
      const record = HistoryRecordSchema.parse({ id, sessionId, fromSeq, toSeq, sourceRefs, summary: summary.trim(), at: this.clock() });
      await appendJsonl(this.paths.history, record);
      state.memoryCursor[sessionId] = toSeq;
      await this.writeState(state);
      latest = record;
    }
    return latest;
  }

  private async readState(): Promise<State> {
    try { return StateSchema.parse(await readJson(this.paths.state, StateSchema)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { memoryCursor: {} }; throw error; }
  }
  private writeState(state: State): Promise<void> { return writeJsonAtomic(this.paths.state, state); }
}
