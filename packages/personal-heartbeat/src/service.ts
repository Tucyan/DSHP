import { AgentActionSchema, assertActionAllowedForTrigger, type AgentAction, type AgentTrigger } from '@personal-growth/shared';
import { z } from 'zod';
import { evaluateContactPolicy, HeartbeatConfigSchema, Rfc3339InstantSchema, type CandidateImportance, type ContactPolicyResult, type HeartbeatConfig } from './contact-policy.js';
import { HeartbeatLedger, type SafeErrorCode } from './ledger.js';
import { toDate, type Instant } from './timezone.js';

export interface HeartbeatCorePort { handle(trigger: AgentTrigger): Promise<AgentAction>; }
export interface HiddenSessionSink { append(record: { occurrenceId: string; at: string; actionType: AgentAction['type']; status: 'completed' | 'failed'; errorCode?: SafeErrorCode }): Promise<void>; }
export interface HeartbeatServiceOptions {
  workspace?: string; workspaceDir?: string; workspaceRoot?: string;
  config?: Partial<HeartbeatConfig>; policy?: Partial<HeartbeatConfig>;
  core?: HeartbeatCorePort; sink?: HiddenSessionSink; clock?: () => string; lockTimeoutMs?: number; staleGraceMs?: number; isProcessAlive?: (pid: number) => boolean | Promise<boolean>; monotonicNow?: () => number; delay?: (milliseconds: number) => Promise<void>;
}
export interface ForegroundWake { occurrenceId: string; at?: Instant; importance: CandidateImportance; }
export interface BackgroundWake { occurrenceId: string; at?: Instant; }
export type WakeResult = {
  status: 'completed' | 'denied' | 'duplicate'; occurrenceId: string; action?: AgentAction; policy?: ContactPolicyResult;
};
const ForegroundWakeSchema = z.object({ occurrenceId: z.string().min(1).max(256), at: z.union([z.string().min(1), z.number().finite(), z.date()]).optional(), importance: z.enum(['low', 'normal', 'high']) }).strict();
const BackgroundWakeSchema = z.object({ occurrenceId: z.string().min(1).max(256), at: z.union([z.string().min(1), z.number().finite(), z.date()]).optional() }).strict();

function safeError(error: unknown): SafeErrorCode {
  if (error && typeof error === 'object' && 'code' in error && ['invalid_action', 'policy_violation', 'invalid_state', 'state_corrupt'].includes(String((error as { code?: unknown }).code))) return (error as { code: SafeErrorCode }).code;
  if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'POLICY_VIOLATION') return 'policy_violation';
  if (error instanceof Error && /Invalid agent action|not allowed for background_heartbeat|not allowed for foreground_heartbeat/i.test(error.message)) return 'policy_violation';
  return 'core_error';
}
class ClassifiedActionError extends Error { constructor(message: string, readonly code: 'invalid_action' | 'policy_violation') { super(message); this.name = 'ClassifiedActionError'; } }
function validateCoreAction(trigger: AgentTrigger, raw: unknown): AgentAction {
  const parsed = AgentActionSchema.safeParse(raw);
  if (!parsed.success) throw new ClassifiedActionError('Invalid agent action returned by Core', 'invalid_action');
  try { return assertActionAllowedForTrigger(trigger, parsed.data); }
  catch (error) { throw new ClassifiedActionError(error instanceof Error ? error.message : 'Action is not allowed for trigger', 'policy_violation'); }
}

export class HeartbeatService {
  readonly config: HeartbeatConfig;
  readonly ledger: HeartbeatLedger;
  private readonly core?: HeartbeatCorePort;
  private readonly sink?: HiddenSessionSink;
  private readonly clock: () => string;

  constructor(options: HeartbeatServiceOptions = {}) {
    const workspace = options.workspaceRoot ?? options.workspaceDir ?? options.workspace ?? process.cwd();
    const configInput = { ...(options.config ?? {}), ...(options.policy ?? {}) };
    this.config = HeartbeatConfigSchema.parse(configInput);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.ledger = new HeartbeatLedger(workspace, options.lockTimeoutMs, { monotonicNow: options.monotonicNow, delay: options.delay, staleGraceMs: options.staleGraceMs, isProcessAlive: options.isProcessAlive });
    this.core = options.core; this.sink = options.sink;
  }

  wakeForeground(input: ForegroundWake): Promise<WakeResult> {
    const parsed = ForegroundWakeSchema.parse(input); const at = instantString(parsed.at, this.clock);
    return this.foreground(parsed.occurrenceId, at, parsed.importance);
  }

  wakeBackground(input: BackgroundWake): Promise<WakeResult> {
    const parsed = BackgroundWakeSchema.parse(input); const at = instantString(parsed.at, this.clock);
    return this.background(parsed.occurrenceId, at);
  }

  private async foreground(occurrenceId: string, at: string, importance: CandidateImportance): Promise<WakeResult> {
    const admission = await this.ledger.transact(async (transaction) => {
      const claimed = transaction.claim(occurrenceId, 'foreground', at);
      if (claimed.duplicate) return { status: 'duplicate', occurrenceId } as const;
      await transaction.save(); // durable claim must precede every Core call
      let policy: ContactPolicyResult;
      try { policy = evaluateContactPolicy(this.config, transaction.state, at, importance); }
      catch (error) { transaction.fail(occurrenceId, at, safeError(error)); await transaction.save(); throw error; }
      if (!policy.allowed) {
        const action: AgentAction = { type: 'NOOP', reason: policy.code };
        transaction.complete(occurrenceId, at, 'NOOP', policy.code); await transaction.save();
        return { status: 'denied', occurrenceId, action, policy } as const;
      }
      transaction.reserveContact({ occurrenceId, at, localDay: policy.metadata.localDate, status: 'active' }, policy.metadata.localDate);
      await transaction.save();
      return { status: 'claimed', occurrenceId, policy } as const;
    });
    if (admission.status === 'duplicate' || admission.status === 'denied') return admission;
    if (!this.core) { await this.ledger.transact(async (transaction) => { transaction.markContactUncertain(occurrenceId); transaction.fail(occurrenceId, at, 'core_error'); await transaction.save(); }); throw new Error('personalHeartbeat core is not configured'); }
    const trigger: AgentTrigger = { type: 'foreground_heartbeat', occurrenceId, at };
    let action: AgentAction;
    try { action = validateCoreAction(trigger, await this.core.handle(trigger)); }
    catch (error) {
      const errorCode = safeError(error); await this.ledger.transact(async (transaction) => { transaction.markContactUncertain(occurrenceId); transaction.fail(occurrenceId, at, errorCode); await transaction.save(); }); throw error;
    }
    await this.ledger.transact(async (transaction) => { transaction.finalizeContact(occurrenceId, action.type, at, action.type === 'MESSAGE_USER' ? action.importance : undefined); transaction.complete(occurrenceId, at, action.type); await transaction.save(); });
    return { status: 'completed', occurrenceId, action, policy: admission.policy };
  }

  private async background(occurrenceId: string, at: string): Promise<WakeResult> {
    const claimed = await this.ledger.transact(async (transaction) => {
      const claimed = transaction.claim(occurrenceId, 'background', at);
      if (claimed.duplicate) return { status: 'duplicate', occurrenceId } as const;
      await transaction.save();
      return { status: 'claimed', occurrenceId } as const;
    });
    if (claimed.status === 'duplicate') return claimed;
    if (!this.core) { await this.ledger.transact(async (transaction) => { transaction.fail(occurrenceId, at, 'core_error'); await transaction.save(); }); throw new Error('personalHeartbeat core is not configured'); }
    if (!this.sink) { await this.ledger.transact(async (transaction) => { transaction.fail(occurrenceId, at, 'sink_error'); await transaction.save(); }); throw new Error('personalHeartbeat hidden sink is not configured'); }
    const trigger: AgentTrigger = { type: 'background_heartbeat', occurrenceId, at };
    let action: AgentAction;
    try { action = validateCoreAction(trigger, await this.core.handle(trigger)); }
    catch (error) {
      const errorCode = safeError(error); await this.ledger.transact(async (transaction) => { transaction.fail(occurrenceId, at, errorCode); await transaction.save(); }); throw error;
    }
    const record = { occurrenceId, at, actionType: action.type, status: 'completed' as const };
    try { await this.sink.append(record); }
    catch (error) { await this.ledger.transact(async (transaction) => { transaction.fail(occurrenceId, at, 'sink_error'); await transaction.save(); }); throw error; }
    await this.ledger.transact(async (transaction) => { transaction.complete(occurrenceId, at, action.type); await transaction.save(); });
    return { status: 'completed', occurrenceId, action };
  }

  /** Exposes the injected clock for adapters that need an occurrence timestamp. */
  now(): string { return this.clock(); }
}

function instantString(value: Instant | undefined, clock: () => string): string {
  const selected = value ?? clock(); toDate(selected); return typeof selected === 'string' ? Rfc3339InstantSchema.parse(selected) : toDate(selected).toISOString();
}
