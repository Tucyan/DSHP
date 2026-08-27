import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime, type WorkerOptions } from '../src/runtime.js';

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
});
