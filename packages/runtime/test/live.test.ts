import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLiveRuntime } from '../src/runtime.js';
import { runLive } from '../src/cli.js';
import { DemoModel } from '../src/demo-model.js';

describe('live composition contract', () => {
  it('uses injected Tencent transport and DSH schedule boundary rather than local memory transport', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-live-')); const sent: string[] = [];
    async function* inbound() { yield { peerId: 'peer-1', context: 'private' as const, messageId: 'm1', text: 'remember focused evening study', at: '2026-08-27T10:00:00.000Z' }; yield { peerId: 'peer-1', context: 'private' as const, messageId: 'm2', text: 'second chat', at: '2026-08-27T10:01:00.000Z' }; }
    const runtime = await createLiveRuntime({
      repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z',
      model: new DemoModel(), goalPort: { getCurrentGoal: () => undefined },
      transport: { sendPrivate: async (_peer, text) => { sent.push(text); } }, inbound: inbound(),
      scheduleTool: { create: async () => ({ id: 'remote-1' }), list: async () => [], delete: async () => true },
    });
    expect((await runtime.processNext())?.action.type).toBe('RESPOND');
    expect((await runtime.processNext())?.action.type).toBe('RESPOND');
    expect(sent).toEqual(['已记录：remember focused evening study', '已记录：second chat']);
    expect(runtime.qq.outbox).toHaveLength(2);
  });
  it('starts a consumable live controller when credentials and host bridge are supplied', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-live-controller-')); const sent: string[] = [];
    async function* inbound() { yield { peerId: 'peer-2', context: 'private' as const, messageId: 'm1', text: 'temporary chat', at: '2026-08-27T10:00:00.000Z' }; yield { peerId: 'peer-2', context: 'private' as const, messageId: 'm2', text: 'second chat', at: '2026-08-27T10:01:00.000Z' }; }
    const oldApp = process.env.QQBOT_APPID; const oldSecret = process.env.QQBOT_SECRET; process.env.QQBOT_APPID = 'test'; process.env.QQBOT_SECRET = 'test';
    try {
      const controller = await runLive(root, { peerId: 'peer-2', model: new DemoModel(), goalPort: { getCurrentGoal: () => undefined }, inbound: inbound(), transport: { sendPrivate: async (_peer, text) => { sent.push(text); } }, scheduleTool: { create: async () => ({ id: 'x' }), list: async () => [], delete: async () => true } });
      await controller.done;
      // The controller also owns a foreground worker. Under a loaded suite it
      // may legitimately emit one policy-approved proactive message before
      // the two-message stream drains, so assert the direct replies exactly.
      expect(sent.filter((text) => text.startsWith('已记录：'))).toEqual(['已记录：temporary chat', '已记录：second chat']);
    } finally { if (oldApp === undefined) delete process.env.QQBOT_APPID; else process.env.QQBOT_APPID = oldApp; if (oldSecret === undefined) delete process.env.QQBOT_SECRET; else process.env.QQBOT_SECRET = oldSecret; }
  });
});
