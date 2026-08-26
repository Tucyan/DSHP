import { z } from 'zod';

export const TraceRecordSchema = z.object({
  at: z.string().min(1),
  event: z.string().min(1),
  data: z.unknown().optional(),
}).passthrough();

export type TraceRecord = z.infer<typeof TraceRecordSchema>;

const isSecretKey = (key: string): boolean =>
  /(secret|token|password|apikey)/i.test(key.replace(/[_-]/g, ''));

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item)) as T;
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = isSecretKey(key) ? '[REDACTED]' : redactSecrets(item);
    }
    return result as T;
  }
  return value;
}

export const redactTrace = redactSecrets;
