import { describe, expect, it } from 'vitest';
import { redactSecrets, TraceRecordSchema } from '../src/trace.js';

describe('trace records', () => {
  it('validates records and recursively redacts secret-like keys regardless of case', () => {
    const record = {
      at: '2026-08-26T00:00:00.000Z',
      event: 'model.request',
      data: {
        Token: 'abc',
        nested: { password: 'pw', APIKEY: 'key', keep: 'yes' },
        list: [{ appSecret: 'app', value: 1 }],
        credentials: 'credentials',
        private_key: 'private',
        Authorization: 'authorization',
        accessKey: 'access',
        bearer: 'bearer',
        authHeader: 'auth-header',
      },
    };
    expect(TraceRecordSchema.safeParse(record).success).toBe(true);
    expect(redactSecrets(record)).toEqual({
      at: record.at,
      event: record.event,
      data: {
        Token: '[REDACTED]',
        nested: { password: '[REDACTED]', APIKEY: '[REDACTED]', keep: 'yes' },
        list: [{ appSecret: '[REDACTED]', value: 1 }],
        credentials: '[REDACTED]',
        private_key: '[REDACTED]',
        Authorization: '[REDACTED]',
        accessKey: '[REDACTED]',
        bearer: '[REDACTED]',
        authHeader: '[REDACTED]',
      },
    });
  });
});
