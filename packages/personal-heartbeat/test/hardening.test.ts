import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HeartbeatService, HeartbeatStateSchema, type HeartbeatCorePort } from '../src/index.js';
import { writeJsonAtomic } from '@personal-growth/shared';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const root = async () => { const value = await mkdtemp(join(tmpdir(), 'heartbeat-hardening-')); roots.push(value); return value; };
const config = { timeZone: 'UTC', quietHours: { start: '00:00', end: '00:00' }, cooldownMinutes: 0, maxContactsPerDay: 4 } as const;

it('persists policy failure as a safe policy_violation and never retries it', async () => {
  const workspace = await root();
  const core: HeartbeatCorePort = { handle: async () => ({ type: 'MESSAGE_USER', text: 'forbidden', importance: 'normal' }) };
  const service = new HeartbeatService({ workspace, config, core, sink: { append: async () => undefined } });
  await expect(service.wakeBackground({ occurrenceId: 'policy', at: '2026-01-01T12:00:00Z' })).rejects.toThrow();
  const state = HeartbeatStateSchema.parse(JSON.parse(await readFile(join(workspace, 'data', 'heartbeat-state.json'), 'utf8')));
  expect(state.occurrences.policy).toMatchObject({ status: 'failed', errorCode: 'policy_violation' });
  await expect(service.wakeBackground({ occurrenceId: 'policy', at: '2026-01-01T12:00:00Z' })).resolves.toMatchObject({ status: 'duplicate' });
});

it('claims one concurrent occurrence across two reconstructed services', async () => {
  const workspace = await root(); let calls = 0;
  const core: HeartbeatCorePort = { handle: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return { type: 'REFLECT', summary: 'private' }; } };
  const a = new HeartbeatService({ workspace, config, core, sink: { append: async () => undefined } });
  const b = new HeartbeatService({ workspace, config, core, sink: { append: async () => undefined } });
  const results = await Promise.all([a.wakeBackground({ occurrenceId: 'race', at: '2026-01-01T12:00:00Z' }), b.wakeBackground({ occurrenceId: 'race', at: '2026-01-01T12:00:00Z' })]);
  expect(results.filter((result) => result.status === 'completed')).toHaveLength(1); expect(calls).toBe(1);
});

it('serializes distinct foreground occurrences through policy and contact recording', async () => {
  const workspace = await root(); let calls = 0;
  const core: HeartbeatCorePort = { handle: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return { type: 'MESSAGE_USER', text: 'private', importance: 'normal' }; } };
  const options = { workspace, config: { ...config, maxContactsPerDay: 1 }, core, clock: () => '2026-01-01T12:00:00Z' };
  const a = new HeartbeatService(options); const b = new HeartbeatService(options);
  const results = await Promise.all([
    a.wakeForeground({ occurrenceId: 'distinct-a', importance: 'normal' }),
    b.wakeForeground({ occurrenceId: 'distinct-b', importance: 'normal' }),
  ]);
  expect(calls).toBe(1); expect(results.filter((result) => result.status === 'completed')).toHaveLength(1); expect(results.filter((result) => result.status === 'denied')).toHaveLength(1);
});

it('allows Core to reentrantly invoke another heartbeat without deadlocking', async () => {
  const workspace = await root(); let nested: Promise<unknown> | undefined; let first = true;
  const holder: { service?: HeartbeatService } = {};
  const core: HeartbeatCorePort = { handle: async () => {
    if (first) { first = false; nested = holder.service!.wakeBackground({ occurrenceId: 'nested', at: '2026-01-01T12:00:00Z' }); await nested; }
    return { type: 'REFLECT', summary: 'hidden' };
  } };
  const service = new HeartbeatService({ workspace, config, core, sink: { append: async () => undefined }, lockTimeoutMs: 100 }); holder.service = service;
  await expect(service.wakeBackground({ occurrenceId: 'outer', at: '2026-01-01T12:00:00Z' })).resolves.toMatchObject({ status: 'completed' });
  await expect(nested).resolves.toMatchObject({ status: 'completed' });
});

it('allows foreground Core reentrancy while counting its persisted reservation', async () => {
  const workspace = await root(); let nested: Promise<unknown> | undefined; let first = true;
  const holder: { service?: HeartbeatService } = {};
  const core: HeartbeatCorePort = { handle: async () => {
    if (first) { first = false; nested = holder.service!.wakeForeground({ occurrenceId: 'foreground-nested', at: '2026-01-01T12:00:00Z', importance: 'normal' }); await nested; }
    return { type: 'MESSAGE_USER', text: 'private', importance: 'normal' };
  } };
  const service = new HeartbeatService({ workspace, config: { ...config, maxContactsPerDay: 1 }, core, lockTimeoutMs: 100 }); holder.service = service;
  await expect(service.wakeForeground({ occurrenceId: 'foreground-outer', at: '2026-01-01T12:00:00Z', importance: 'normal' })).resolves.toMatchObject({ status: 'completed' });
  await expect(nested).resolves.toMatchObject({ status: 'denied' });
});

it('allows the hidden sink to reentrantly invoke another heartbeat', async () => {
  const workspace = await root(); let nested: Promise<unknown> | undefined; let first = true;
  const holder: { service?: HeartbeatService } = {};
  const sink = { append: async () => { if (first) { first = false; nested = holder.service!.wakeBackground({ occurrenceId: 'sink-nested', at: '2026-01-01T12:00:00Z' }); await nested; } } };
  const service = new HeartbeatService({ workspace, config, core: { handle: async () => ({ type: 'REFLECT', summary: 'hidden' }) }, sink, lockTimeoutMs: 100 }); holder.service = service;
  await expect(service.wakeBackground({ occurrenceId: 'sink-outer', at: '2026-01-01T12:00:00Z' })).resolves.toMatchObject({ status: 'completed' });
  await expect(nested).resolves.toMatchObject({ status: 'completed' });
});

it('keeps an uncertain contact reservation after Core failure', async () => {
  const workspace = await root();
  const service = new HeartbeatService({ workspace, config: { ...config, maxContactsPerDay: 1 }, core: { handle: async () => { throw new Error('uncertain'); } } });
  await expect(service.wakeForeground({ occurrenceId: 'failed-contact', at: '2026-01-01T12:00:00Z', importance: 'normal' })).rejects.toThrow('uncertain');
  const followUp = await service.wakeForeground({ occurrenceId: 'follow-up', at: '2026-01-01T12:01:00Z', importance: 'normal' });
  expect(followUp.status).toBe('denied'); expect(followUp.policy?.code).toBe('daily_cap');
  const state = HeartbeatStateSchema.parse(JSON.parse(await readFile(join(workspace, 'data', 'heartbeat-state.json'), 'utf8')));
  expect(state.reservations).toEqual([{ occurrenceId: 'failed-contact', at: '2026-01-01T12:00:00Z', localDay: '2026-01-01', status: 'uncertain' }]);
});

it('classifies schema-invalid and trigger-forbidden Core actions separately', async () => {
  const invalidWorkspace = await root();
  const invalid = new HeartbeatService({ workspace: invalidWorkspace, config, core: { handle: async () => ({ type: 'NOT_AN_ACTION' } as never) }, sink: { append: async () => undefined } });
  await expect(invalid.wakeBackground({ occurrenceId: 'invalid-action', at: '2026-01-01T12:00:00Z' })).rejects.toThrow();
  const invalidState = HeartbeatStateSchema.parse(JSON.parse(await readFile(join(invalidWorkspace, 'data', 'heartbeat-state.json'), 'utf8')));
  expect(invalidState.occurrences['invalid-action']).toMatchObject({ status: 'failed', errorCode: 'invalid_action' });
  const forbiddenWorkspace = await root();
  const forbidden = new HeartbeatService({ workspace: forbiddenWorkspace, config, core: { handle: async () => ({ type: 'RESPOND', text: 'not allowed' } as never) }, sink: { append: async () => undefined } });
  await expect(forbidden.wakeBackground({ occurrenceId: 'forbidden-action', at: '2026-01-01T12:00:00Z' })).rejects.toThrow();
  const forbiddenState = HeartbeatStateSchema.parse(JSON.parse(await readFile(join(forbiddenWorkspace, 'data', 'heartbeat-state.json'), 'utf8')));
  expect(forbiddenState.occurrences['forbidden-action']).toMatchObject({ status: 'failed', errorCode: 'policy_violation' });
});

it('fails closed on a future persisted contact even when cooldown is zero', async () => {
  const workspace = await root();
  await writeJsonAtomic(join(workspace, 'data', 'heartbeat-state.json'), { version: 1, occurrences: {}, contacts: [{ occurrenceId: 'future', at: '2026-01-02T00:00:00Z', actionType: 'MESSAGE_USER', importance: 'normal' }], reservations: [] });
  const service = new HeartbeatService({ workspace, config: { ...config, cooldownMinutes: 0 }, core: { handle: async () => ({ type: 'MESSAGE_USER', text: 'must not run', importance: 'normal' }) } });
  await expect(service.wakeForeground({ occurrenceId: 'future-check', at: '2026-01-01T12:00:00Z', importance: 'normal' })).rejects.toThrow(/future|state|invalid/i);
});
