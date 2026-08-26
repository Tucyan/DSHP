import crypto from 'node:crypto';
import path from 'node:path';
import { durableJsonRead, durableJsonTransaction } from '@personal-growth/shared';
import { z } from 'zod';

const RequestSchema = z.object({
  sessionId: z.string().min(1), prompt: z.string().min(1), kind: z.enum(['once', 'interval']),
  at: z.string().datetime(), everySeconds: z.number().int().min(300).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'interval' && value.everySeconds === undefined) ctx.addIssue({ code: 'custom', message: 'interval requires everySeconds' });
  if (value.kind === 'once' && value.everySeconds !== undefined) ctx.addIssue({ code: 'custom', message: 'once cannot have everySeconds' });
});

export type ScheduleRequest = z.infer<typeof RequestSchema>;
export interface ScheduleBinding extends ScheduleRequest { id: string; idempotencyKey: string; status: 'scheduled' | 'overdue'; createdAt: string; }
export interface DshSchedulePort {
  create(request: ScheduleRequest, idempotencyKey?: string): Promise<ScheduleBinding>;
  list(sessionId?: string): Promise<ScheduleBinding[]>;
  delete(id: string): Promise<boolean>;
}
export class ScheduleAdapterError extends Error {
  constructor(readonly code: 'INVALID_SCHEDULE' | 'IDEMPOTENCY_CONFLICT' | 'ADAPTER_FAILURE' | 'SESSION_OWNERSHIP' | 'UNSUPPORTED_OPERATION', message: string) { super(message); this.name = 'ScheduleAdapterError'; }
}
function normalizedScheduleError(operation: string, error: unknown): ScheduleAdapterError {
  if (error instanceof ScheduleAdapterError) return error;
  return new ScheduleAdapterError('ADAPTER_FAILURE', `${operation} failed`);
}
const TimestampSchema = z.string().datetime().refine((value) => { const epoch = Date.parse(value); return Number.isFinite(epoch) && epoch >= Date.UTC(2000, 0, 1) && epoch <= Date.UTC(2100, 0, 1); }, 'timestamp is outside supported range');
const StateSchema = z.array(z.object({ id: z.string().min(1), sessionId: z.string().min(1), prompt: z.string().min(1), kind: z.enum(['once', 'interval']), at: TimestampSchema, everySeconds: z.number().int().min(300).optional(), idempotencyKey: z.string().min(1), status: z.enum(['scheduled', 'overdue']), createdAt: TimestampSchema }).strict());
const NowSchema = TimestampSchema;
type State = z.infer<typeof StateSchema>;
const idFor = (key: string, request: ScheduleRequest) => crypto.createHash('sha256').update(`${key}\0${JSON.stringify(request)}`).digest('hex').slice(0, 24);

export class FakeDshSchedule implements DshSchedulePort {
  private readonly entries: State;
  constructor(snapshot: unknown = []) { this.entries = StateSchema.parse(snapshot); }
  async create(raw: ScheduleRequest, idempotencyKey = ''): Promise<ScheduleBinding> {
    const parsed = RequestSchema.safeParse(raw);
    if (!parsed.success) throw new ScheduleAdapterError('INVALID_SCHEDULE', parsed.error.message);
    const request = parsed.data;
    const key = idempotencyKey || idFor('', request);
    const existing = this.entries.find((entry) => entry.idempotencyKey === key);
    if (existing) {
      const sameRequest = existing.sessionId === request.sessionId && existing.prompt === request.prompt && existing.kind === request.kind && existing.at === request.at && existing.everySeconds === request.everySeconds;
      if (!sameRequest) throw new ScheduleAdapterError('IDEMPOTENCY_CONFLICT', 'schedule idempotency key is already bound to a different request');
      return { ...existing };
    }
    const entry: ScheduleBinding = { ...request, id: idFor(key, request), idempotencyKey: key, status: 'scheduled', createdAt: new Date().toISOString() };
    this.entries.push(entry);
    return { ...entry };
  }
  async list(sessionId?: string): Promise<ScheduleBinding[]> { return this.entries.filter((entry) => !sessionId || entry.sessionId === sessionId).map((entry) => ({ ...entry })); }
  async delete(id: string): Promise<boolean> { const index = this.entries.findIndex((entry) => entry.id === id); if (index < 0) return false; this.entries.splice(index, 1); return true; }
  due(now: string): ScheduleBinding[] {
    const parsedNow = NowSchema.parse(now); const nowEpoch = Date.parse(parsedNow);
    for (const entry of this.entries) if (entry.kind === 'once' && entry.status === 'scheduled' && Date.parse(entry.at) <= nowEpoch) entry.status = 'overdue';
    return this.entries.filter((entry) => entry.status === 'overdue').map((entry) => ({ ...entry }));
  }
  snapshot(): State { return this.entries.map((entry) => ({ ...entry })); }
}

/** Durable binding store. DSH itself executes these only while the bound session is live. */
export class DshSchedule implements DshSchedulePort {
  private fake: FakeDshSchedule;
  private readonly statePath?: string;
  private readonly runtimeRoot: string;
  private writeQueue = Promise.resolve();
  constructor(statePath?: string, snapshot?: unknown, runtimeRoot?: string) { this.statePath = statePath; this.runtimeRoot = path.resolve(runtimeRoot ?? (statePath ? path.dirname(statePath) : process.cwd())); this.fake = new FakeDshSchedule(snapshot); }
  static async open(statePath: string, runtimeRoot = path.dirname(statePath)): Promise<DshSchedule> {
    const snapshot = await durableJsonRead(statePath, runtimeRoot, StateSchema, []);
    return new DshSchedule(statePath, snapshot, runtimeRoot);
  }
  recover(now: string): Promise<ScheduleBinding[]> { return this.mutate(async (schedule) => schedule.due(now)).catch((error: unknown) => { throw normalizedScheduleError('schedule recovery', error); }); }
  private mutate<T>(fn: (schedule: FakeDshSchedule) => Promise<T>): Promise<T> { const result = this.writeQueue.then(async () => { if (!this.statePath) { const value = await fn(this.fake); return value; } const transaction = await durableJsonTransaction(this.statePath, this.runtimeRoot, StateSchema, [], async (state) => { const working = new FakeDshSchedule(state); const value = await fn(working); state.splice(0, state.length, ...working.snapshot()); this.fake = working; return value; }); return transaction.result; }); this.writeQueue = result.then(() => undefined, () => undefined); return result; }
  create(request: ScheduleRequest, idempotencyKey?: string) { return this.mutate((schedule) => schedule.create(request, idempotencyKey)).catch((error: unknown) => { throw normalizedScheduleError('schedule create', error); }); }
  async list(sessionId?: string) { try { if (this.statePath) this.fake = new FakeDshSchedule(await durableJsonRead(this.statePath, this.runtimeRoot, StateSchema, [])); return this.fake.list(sessionId); } catch (error) { throw normalizedScheduleError('schedule list', error); } }
  delete(id: string) { return this.mutate((schedule) => schedule.delete(id)).catch((error: unknown) => { throw normalizedScheduleError('schedule delete', error); }); }
}

export interface DshLiveScheduleTool {
  create(input: { sessionId: string; prompt: string; at: string; everySeconds?: number }): Promise<{ id: string }>;
  list?(sessionId: string): Promise<ScheduleBinding[]>;
  delete(id: string): Promise<boolean | void>;
}
/** Narrow live boundary; the caller supplies DSH's schedule tool from the active session. */
export class LiveDshSchedule implements DshSchedulePort {
  private bindings = new Map<string, ScheduleBinding>();
  private readonly statePath?: string;
  private readonly runtimeRoot: string;
  private writeQueue = Promise.resolve();
  constructor(private readonly tool: DshLiveScheduleTool, private readonly sessionId: string, statePath?: string, snapshot: unknown = [], runtimeRoot?: string) {
    this.statePath = statePath;
    this.runtimeRoot = path.resolve(runtimeRoot ?? (statePath ? path.dirname(statePath) : process.cwd()));
    for (const binding of StateSchema.parse(snapshot)) this.bindings.set(binding.id, binding);
  }
  static async open(tool: DshLiveScheduleTool, sessionId: string, statePath: string, runtimeRoot = path.dirname(statePath)): Promise<LiveDshSchedule> {
    const snapshot = await durableJsonRead(statePath, runtimeRoot, StateSchema, []);
    return new LiveDshSchedule(tool, sessionId, statePath, snapshot, runtimeRoot);
  }
  private mutate<T>(fn: (bindings: Map<string, ScheduleBinding>) => Promise<T>): Promise<T> { const result = this.writeQueue.then(async () => { if (!this.statePath) return fn(this.bindings); const transaction = await durableJsonTransaction(this.statePath, this.runtimeRoot, StateSchema, [], async (state) => { const working = new Map(state.map((binding) => [binding.id, binding])); const value = await fn(working); state.splice(0, state.length, ...working.values()); this.bindings = working; return value; }); return transaction.result; }); this.writeQueue = result.then(() => undefined, () => undefined); return result; }
  async create(request: ScheduleRequest, idempotencyKey = ''): Promise<ScheduleBinding> {
    const parsed = RequestSchema.safeParse(request);
    if (!parsed.success) throw new ScheduleAdapterError('INVALID_SCHEDULE', parsed.error.message);
    if (parsed.data.sessionId !== this.sessionId) throw new ScheduleAdapterError('INVALID_SCHEDULE', 'schedule session binding mismatch');
    const key = idempotencyKey || idFor('', parsed.data);
    return this.mutate(async (bindings) => {
      const existing = [...bindings.values()].find((binding) => binding.idempotencyKey === key);
      if (existing) {
        if (existing.sessionId !== parsed.data.sessionId || existing.prompt !== parsed.data.prompt || existing.at !== parsed.data.at || existing.kind !== parsed.data.kind || existing.everySeconds !== parsed.data.everySeconds) throw new ScheduleAdapterError('IDEMPOTENCY_CONFLICT', 'schedule idempotency key is already bound to a different request');
        return { ...existing };
      }
      const result = await this.tool.create({ sessionId: parsed.data.sessionId, prompt: parsed.data.prompt, at: parsed.data.at, everySeconds: parsed.data.everySeconds });
      const binding: ScheduleBinding = { ...parsed.data, id: result.id, idempotencyKey: key, status: 'scheduled', createdAt: new Date().toISOString() };
      bindings.set(binding.id, binding); return { ...binding };
    }).catch((error: unknown) => { throw normalizedScheduleError('live schedule create', error); });
  }
  async list(sessionId = this.sessionId): Promise<ScheduleBinding[]> {
    if (sessionId !== this.sessionId) return [];
    try {
      const result = this.tool.list ? await this.tool.list(sessionId) : this.statePath ? await durableJsonRead(this.statePath, this.runtimeRoot, StateSchema, []) : [...this.bindings.values()];
      const parsed = StateSchema.safeParse(result);
      if (!parsed.success) throw new ScheduleAdapterError('ADAPTER_FAILURE', 'live schedule list returned invalid bindings');
      if (parsed.data.some((binding) => binding.sessionId !== this.sessionId)) throw new ScheduleAdapterError('SESSION_OWNERSHIP', 'live schedule list returned a foreign session binding');
      return parsed.data.map((binding) => ({ ...binding }));
    } catch (error) { throw normalizedScheduleError('live schedule list', error); }
  }
  async recover(now: string): Promise<ScheduleBinding[]> {
    try {
      NowSchema.parse(now); const overdue = await this.mutate(async (bindings) => { const found = [...bindings.values()].filter((binding) => binding.sessionId === this.sessionId && binding.kind === 'once' && binding.status === 'scheduled' && Date.parse(binding.at) <= Date.parse(now)).map((binding) => ({ ...binding, status: 'overdue' as const })); for (const binding of found) bindings.set(binding.id, binding); return found; });
      return overdue;
    } catch (error) { throw normalizedScheduleError('live schedule recovery', error); }
  }
  async delete(id: string): Promise<boolean> {
    return this.mutate(async (bindings) => {
      const binding = bindings.get(id);
      if (!binding) return false;
      if (binding.sessionId !== this.sessionId) throw new ScheduleAdapterError('SESSION_OWNERSHIP', 'schedule belongs to another session');
      const result = await this.tool.delete(id);
      if (result === false) return false;
      bindings.delete(id); return true;
    }).catch((error: unknown) => { throw normalizedScheduleError('live schedule delete', error); });
  }
}
