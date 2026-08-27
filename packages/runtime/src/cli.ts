import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLiveRuntime, createRuntime } from './runtime.js';
import type { QqInbound, QqTransport } from '@personal-growth/qq-adapter';
import type { DshLiveScheduleTool } from '@personal-growth/dsh-adapter';

export async function runDemo(repoRoot?: string): Promise<string> {
  repoRoot ??= await mkdtemp(path.join(tmpdir(), 'personal-growth-demo-'));
  const runtime = await createRuntime({ repoRoot, peerId: 'demo-user', now: () => '2026-08-27T10:00:00.000Z' });
  runtime.qq.pushInbound({ peerId: 'demo-user', context: 'private', messageId: 'demo-1', text: 'Remember my focused evening study preference.', at: '2026-08-27T10:00:00.000Z' });
  await runtime.processNext(); await runtime.runBackground('demo-background'); await runtime.runForeground('demo-foreground', 'high');
  const traces = await runtime.queryTrace(100);
  return `Demo complete: root=${repoRoot}; runtime=${path.join(repoRoot, 'runtime')}; QQ input → response → memory/profile → hidden reflection → proactive contact; traceCount=${traces.length}.`;
}

export function assertLiveCredentials(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.QQBOT_APPID || !env.QQBOT_SECRET) throw new Error('Live QQ requires QQBOT_APPID and QQBOT_SECRET in the process environment; no credential file is read.');
}

export interface LiveController { runtime: Awaited<ReturnType<typeof createLiveRuntime>>; done: Promise<void>; stop(): void; }
export async function runLive(repoRoot: string, ports?: { transport: QqTransport; inbound: AsyncIterable<QqInbound>; scheduleTool: DshLiveScheduleTool; peerId: string }): Promise<LiveController> {
  assertLiveCredentials();
  if (!ports) throw new Error('Live QQ requires injected Tencent transport, inbound stream, and DSH schedule tool; use the managed DSH bridge.');
  const runtime = await createLiveRuntime({ repoRoot, peerId: ports.peerId, transport: ports.transport, inbound: ports.inbound, scheduleTool: ports.scheduleTool });
  const done = runtime.start(); return { runtime, done, stop: () => runtime.stop() };
}

if (process.argv[1]?.endsWith('cli.js')) runDemo().then((summary) => console.log(summary)).catch((error) => { console.error(error instanceof Error ? error.message : 'runtime failed'); process.exitCode = 1; });
