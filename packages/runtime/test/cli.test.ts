import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertLiveCredentials, isDemoEntrypoint, runDemo } from '../src/cli.js';

describe('credential-free demo', () => {
  it('returns a short auditable summary without credentials', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-cli-'));
    const result = await runDemo(root);
    expect(result).toMatch(/demo complete/i);
    expect(result).toContain('memory');
  });
  it('fails live mode clearly when credentials are absent', () => {
    expect(() => assertLiveCredentials({})).toThrow(/Live QQ requires/);
  });
  it('uses an isolated temporary root by default and reports paths without secret contents', async () => {
    const result = await runDemo();
    expect(result).toMatch(/root=.*runtime/i);
    expect(result).toMatch(/traceCount=\d+/i);
    expect(result).not.toMatch(/QQBOT_SECRET|Remember my focused/i);
  });

  it('only runs the demo when the runtime cli module itself is the entrypoint', () => {
    expect(isDemoEntrypoint('C:/repo/packages/dsh-host/dist/cli.js')).toBe(false);
    expect(isDemoEntrypoint(undefined)).toBe(false);
  });
});
