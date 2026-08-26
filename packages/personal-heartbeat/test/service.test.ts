import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeartbeatService, type AgentAction, type HeartbeatCorePort, type HiddenSessionSink } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const root = async () => { const value = await mkdtemp(join(tmpdir(), 'heartbeat-')); roots.push(value); return value; };
const cfg = { timeZone: 'UTC', quietHours: { start: '00:00', end: '00:00' }, cooldownMinutes: 0, maxContactsPerDay: 4 } as const;

describe('heartbeat service', () => {
  it('claims foreground before core, records only message metadata, and dedupes restart', async () => {
    const workspace = await root(); let calls = 0;
    const core: HeartbeatCorePort = { handle: async () => { calls++; return { type: 'MESSAGE_USER', text: 'private', importance: 'normal' }; } };
    const first = new HeartbeatService({ workspace, config: cfg, clock: () => '2026-01-01T12:00:00Z', core });
    expect((await first.wakeForeground({ occurrenceId: 'f1', at: '2026-01-01T12:00:00Z', importance: 'normal' })).status).toBe('completed');
    expect((await new HeartbeatService({ workspace, config: cfg, core }).wakeForeground({ occurrenceId: 'f1', at: '2026-01-01T12:00:00Z', importance: 'normal' })).status).toBe('duplicate');
    expect(calls).toBe(1);
    const raw = await readFile(join(workspace, 'data', 'heartbeat-state.json'), 'utf8');
    expect(raw).not.toContain('private'); expect(raw).not.toContain('text');
  });

  it('denies before core and handles background safely through hidden sink', async () => {
    const workspace = await root(); let calls = 0; const records: unknown[] = [];
    const core: HeartbeatCorePort = { handle: async () => { calls++; return { type: 'REFLECT', summary: 'hidden' }; } };
    const sink: HiddenSessionSink = { append: async (record) => { records.push(record); } };
    const quiet = new HeartbeatService({ workspace, config: { ...cfg, quietHours: { start: '11:00', end: '13:00' } }, core, sink });
    expect((await quiet.wakeForeground({ occurrenceId: 'denied', at: '2026-01-01T12:00:00Z', importance: 'normal' })).status).toBe('denied');
    expect(calls).toBe(0);
    expect((await quiet.wakeBackground({ occurrenceId: 'b1', at: '2026-01-01T12:00:00Z' })).status).toBe('completed');
    expect(records).toEqual([{ occurrenceId: 'b1', at: '2026-01-01T12:00:00Z', actionType: 'REFLECT', status: 'completed' }]);
  });

  it('rejects user-visible background actions and does not retry failures', async () => {
    const workspace = await root(); let calls = 0;
    const core: HeartbeatCorePort = { handle: async () => { calls++; return { type: 'RESPOND', text: 'bad' } as AgentAction; } };
    const service = new HeartbeatService({ workspace, config: cfg, core, sink: { append: async () => undefined } });
    await expect(service.wakeBackground({ occurrenceId: 'bad', at: '2026-01-01T12:00:00Z' })).rejects.toThrow();
    await expect(service.wakeBackground({ occurrenceId: 'bad', at: '2026-01-01T12:00:00Z' })).resolves.toMatchObject({ status: 'duplicate' });
    expect(calls).toBe(1);
  });

  it('has no filesystem side effects until an operation', async () => {
    const workspace = await root(); const service = new HeartbeatService({ workspace, config: cfg });
    expect(await readdir(workspace)).toEqual([]);
    await expect(service.wakeForeground({ occurrenceId: 'x', at: '2026-01-01T12:00:00Z', importance: 'normal' })).rejects.toThrow(/core|configured/i);
  });

  it('uses the injected clock when wake input omits at', async () => {
    const workspace = await root(); const seen: string[] = [];
    const core: HeartbeatCorePort = { handle: async (trigger) => { seen.push(trigger.at); return { type: 'NOOP', reason: 'quiet' }; } };
    const service = new HeartbeatService({ workspace, config: cfg, core, clock: () => '2026-01-01T12:34:56Z' });
    await service.wakeForeground({ occurrenceId: 'clocked', importance: 'normal' });
    expect(seen).toEqual(['2026-01-01T12:34:56Z']);
  });
});
