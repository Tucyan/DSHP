import { z } from 'zod';

export const TimeZoneSchema = z.string().min(1).refine((value) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}, 'timeZone must be a valid IANA timezone');

export const LocalDateTimeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  minute: z.number().int().min(0).max(1439),
}).strict();
export type LocalDateTime = z.infer<typeof LocalDateTimeSchema>;

export type Instant = string | number | Date;

export function toDate(now: Instant): Date {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid heartbeat instant');
  return date;
}

export function localDateTime(now: Instant, timeZone: string): LocalDateTime {
  const date = toDate(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return LocalDateTimeSchema.parse({ date: `${values.year}-${values.month}-${values.day}`, minute: Number(values.hour) * 60 + Number(values.minute) });
}

export const getLocalDateTime = localDateTime;
export function getLocalDate(now: Instant, timeZone: string): string { return localDateTime(now, timeZone).date; }
export function getLocalMinute(now: Instant, timeZone: string): number { return localDateTime(now, timeZone).minute; }
