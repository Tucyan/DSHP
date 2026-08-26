import { z } from 'zod';
import { localDateTime, toDate, type Instant } from './timezone.js';
import { TimeZoneSchema } from './timezone.js';

const minute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected exact HH:mm');
export const Rfc3339InstantSchema = z.string().datetime({ offset: true });
export const QuietHoursSchema = z.object({ start: minute, end: minute }).strict();
export const HeartbeatConfigSchema = z.object({
  timeZone: TimeZoneSchema.default('UTC'),
  quietHours: QuietHoursSchema.default({ start: '00:00', end: '08:00' }),
  cooldownMinutes: z.number().finite().int().min(0).max(7 * 24 * 60).default(120),
  maxContactsPerDay: z.number().finite().int().min(1).max(100).default(4),
}).strict();
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;
export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = HeartbeatConfigSchema.parse({});
export const HeartbeatPolicySchema = HeartbeatConfigSchema;
export function parseHeartbeatConfig(input: unknown): HeartbeatConfig { return HeartbeatConfigSchema.parse(input); }

export const ContactRecordSchema = z.object({
  occurrenceId: z.string().min(1).max(256),
  at: Rfc3339InstantSchema,
  actionType: z.literal('MESSAGE_USER'),
  importance: z.enum(['low', 'normal', 'high']),
}).strict();
export type ContactRecord = z.infer<typeof ContactRecordSchema>;
export const ContactReservationSchema = z.object({
  occurrenceId: z.string().min(1).max(256), at: Rfc3339InstantSchema, localDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), status: z.enum(['active', 'uncertain']),
}).strict();
export type ContactReservation = z.infer<typeof ContactReservationSchema>;
export interface ContactHistory { contacts: readonly ContactRecord[]; reservations?: readonly ContactReservation[]; }
export const ContactHistorySchema = z.object({ contacts: z.array(ContactRecordSchema), reservations: z.array(ContactReservationSchema).optional() }).strict();
export type CandidateImportance = 'low' | 'normal' | 'high';
export type Candidate = CandidateImportance | { importance: CandidateImportance };
export const CandidateImportanceSchema = z.enum(['low', 'normal', 'high']);
export type ContactPolicyCode = 'quiet_hours' | 'cooldown' | 'daily_cap' | 'allowed';
export interface ContactPolicyResult {
  allowed: boolean;
  code: ContactPolicyCode;
  metadata: {
    localDate: string;
    localMinute: number;
    contactsToday: number;
    latestContactAt?: string;
    cooldownBypassed: boolean;
    dailyCapBypassed: boolean;
  };
}
export class ContactStateError extends Error { readonly code = 'invalid_state'; constructor(message: string) { super(message); this.name = 'ContactStateError'; } }

function parseMinute(value: string): number { return Number(value.slice(0, 2)) * 60 + Number(value.slice(3)); }
function inQuietWindow(value: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? value >= start && value < end : value >= start || value < end;
}

export function evaluateContactPolicy(configInput: HeartbeatConfig, historyInput: ContactHistory | readonly ContactRecord[] | undefined, now: Instant, importance: CandidateImportance): ContactPolicyResult;
export function evaluateContactPolicy(configInput: HeartbeatConfig, historyInput: ContactHistory | readonly ContactRecord[] | undefined, candidate: Candidate, now: Instant): ContactPolicyResult;
export function evaluateContactPolicy(configInput: HeartbeatConfig, historyInput: ContactHistory | readonly ContactRecord[] | undefined, nowOrCandidate: Instant | Candidate, importanceOrNow: CandidateImportance | Instant): ContactPolicyResult {
  // Accept both the documented (config, history, now, importance) order and the
  // original plan's (config, history, candidate, now) order.
  const candidateValues = new Set<CandidateImportance>(['low', 'normal', 'high']);
  const oldOrder = (typeof nowOrCandidate === 'object' && !(nowOrCandidate instanceof Date)) || candidateValues.has(nowOrCandidate as CandidateImportance);
  const now = (oldOrder ? importanceOrNow : nowOrCandidate) as Instant;
  const importance = (oldOrder ? nowOrCandidate : importanceOrNow) as Candidate;
  const candidateImportance = CandidateImportanceSchema.parse(typeof importance === 'string' ? importance : importance.importance);
  const config = HeartbeatConfigSchema.parse(configInput);
  const history: readonly ContactRecord[] = Array.isArray(historyInput) ? historyInput as readonly ContactRecord[] : historyInput && 'contacts' in historyInput ? historyInput.contacts : [];
  const reservations: readonly ContactReservation[] = historyInput && !Array.isArray(historyInput) && 'reservations' in historyInput ? (historyInput as ContactHistory & { reservations?: readonly ContactReservation[] }).reservations ?? [] : [];
  const { date: localDate, minute: localMinute } = localDateTime(now, config.timeZone);
  const nowTime = toDate(now).getTime();
  const start = parseMinute(config.quietHours.start); const end = parseMinute(config.quietHours.end);
  const validContacts = history.map((record) => {
    const parsed = ContactRecordSchema.safeParse(record); if (!parsed.success) throw new ContactStateError('Invalid persisted contact state');
    const time = toDate(parsed.data.at).getTime(); if (time > nowTime) throw new ContactStateError('Persisted contact timestamp is in the future');
    return { record: parsed.data, time };
  });
  const validReservations = reservations.map((reservation) => {
    const parsed = ContactReservationSchema.safeParse(reservation); if (!parsed.success) throw new ContactStateError('Invalid persisted reservation state');
    const time = toDate(parsed.data.at).getTime(); if (time > nowTime) throw new ContactStateError('Persisted reservation timestamp is in the future');
    if (parsed.data.localDay !== localDateTime(parsed.data.at, config.timeZone).date) throw new ContactStateError('Persisted reservation local day is inconsistent');
    return { record: parsed.data, time };
  });
  const today = validContacts.filter((entry) => localDateTime(entry.record.at, config.timeZone).date === localDate);
  const reservationsToday = validReservations.filter((entry) => entry.record.localDay === localDate);
  const allValid = [...validContacts, ...validReservations];
  const latest = allValid.sort((a, b) => b.time - a.time)[0];
  const metadata = { localDate, localMinute, contactsToday: today.length + reservationsToday.length, latestContactAt: latest?.record.at, cooldownBypassed: candidateImportance === 'high', dailyCapBypassed: candidateImportance === 'high' };
  if (inQuietWindow(localMinute, start, end)) return { allowed: false, code: 'quiet_hours', metadata };
  if (candidateImportance !== 'high' && latest && (toDate(now).getTime() - latest.time) < config.cooldownMinutes * 60_000) return { allowed: false, code: 'cooldown', metadata };
  if (candidateImportance !== 'high' && metadata.contactsToday >= config.maxContactsPerDay) return { allowed: false, code: 'daily_cap', metadata };
  return { allowed: true, code: 'allowed', metadata };
}

export const contactPolicy = evaluateContactPolicy;
