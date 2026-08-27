# Runtime package

`@personal-growth/runtime` is the composition root for the v0.1 local loop. `createRuntime()` bootstraps isolated paths, wires Agent Core, MemoryService, HeartbeatService, durable QQ and DSH schedule bindings, and accepts a deterministic `DemoModel` for tests and credential-free acceptance.

The normal flow is:

```ts
const runtime = await createRuntime({ repoRoot, peerId: 'fixed-peer' });
runtime.qq.pushInbound({ peerId: 'fixed-peer', context: 'private', messageId: 'm1', text: '...', at });
await runtime.processNext();
await runtime.runBackground('maintenance-1');
await runtime.runForeground('check-in-1', 'normal');
```

Background records are stored under `runtime/sessions/background` and never enter the main conversation or QQ delivery. Skill drafts are independently validated and versioned in the isolated Agents home; plugin proposals remain append-only review artifacts and are never installed by this package.
