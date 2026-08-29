import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime, type WorkerOptions } from '../src/runtime.js';
import { DemoModel } from '../src/demo-model.js';

describe('runtime worker', () => {
  it('drives inbound-independent heartbeats and due dispatch on injected ticks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-worker-')); const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1' });
    let foreground = 0; let background = 0; let dispatch = 0;
    const options: WorkerOptions = { maxTicks: 2, cadenceMs: 0, wait: async () => undefined, foreground: async () => { foreground += 1; }, background: async () => { background += 1; }, dispatch: async () => { dispatch += 1; return []; } };
    await runtime.start(options);
    expect({ foreground, background, dispatch }).toEqual({ foreground: 2, background: 2, dispatch: 2 });
  });

  it('stop closes the inbound boundary and resolves the worker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-worker-stop-')); const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1' });
    let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
    const done = runtime.start({ cadenceMs: 1, wait: async () => wait, background: async () => undefined, foreground: async () => undefined, dispatch: async () => [] });
    runtime.stop(); release();
    await expect(done).resolves.toBeUndefined();
  });

  it('uses Windows-safe occurrence names for default heartbeat workers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-worker-filename-')); const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z' });
    await runtime.start({ maxTicks: 1, cadenceMs: 0 });
    const files = await readdir(path.join(runtime.paths.sessions, 'background'));
    expect(files.length).toBeGreaterThan(0); expect(files.every((file) => !/[<>:"/\\|?*]/u.test(file))).toBe(true);
  });

  it('drains sibling worker work and closes the boundary when one worker fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-worker-failure-')); const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1' });
    let drained = false; let closed = false; runtime.qq.close = async () => { closed = true; };
    await expect(runtime.start({ cadenceMs: 0, foreground: async () => { throw new Error('worker failure'); }, background: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); drained = true; }, dispatch: async () => [] })).rejects.toThrow('worker failure');
    expect({ drained, closed }).toEqual({ drained: true, closed: true });
  });

  it('stop waits for an in-flight inbound core operation to drain', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-worker-drain-')); let release!: () => void; let started!: () => void;
    const startedSignal = new Promise<void>((resolve) => { started = resolve; }); const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
    class BlockingModel extends DemoModel { override async generateAction(...args: Parameters<DemoModel['generateAction']>) { started(); await releaseSignal; return super.generateAction(...args); } }
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', model: new BlockingModel() });
    runtime.qq.pushInbound({ peerId: 'peer-1', context: 'private', messageId: 'drain-message', text: 'hello', at: '2026-08-27T10:00:00.000Z' });
    const running = runtime.start({ maxTicks: 1, cadenceMs: 0, foreground: async () => undefined, background: async () => undefined, dispatch: async () => [] }); await startedSignal;
    let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; }); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false); release(); await stopping; await expect(running).resolves.toBeUndefined(); expect(runtime.qq.outbox).toHaveLength(1);
  });
});
