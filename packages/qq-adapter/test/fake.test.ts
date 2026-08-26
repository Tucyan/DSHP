import { describe, expect, it } from 'vitest';
import { FakeQqPort } from '../src/fake.js';
import { parseQqConfig } from '../src/config.js';

describe('fake QQ port', () => {
  it('maps authorized inbound and idempotent proactive sends', async () => {
    const qq = new FakeQqPort(parseQqConfig({ peerId: 'u-1', appId: 'a', appSecretEnv: 'QQ_SECRET' }));
    qq.pushInbound({ peerId: 'u-1', context: 'private', messageId: 'm1', text: 'hello' });
    expect((await qq.receive())?.text).toBe('hello');
    expect(await qq.send({ occurrenceId: 'o1', idempotencyKey: 'k1', text: 'ping', background: false })).toBe(true);
    expect(await qq.send({ occurrenceId: 'o1', idempotencyKey: 'k1', text: 'ping', background: false })).toBe(false);
    expect(qq.outbox).toHaveLength(1);
  });
  it('prohibits background outbound messages and unauthorized inbound', async () => {
    const qq = new FakeQqPort(parseQqConfig({ peerId: 'u-1', appId: 'a', appSecretEnv: 'QQ_SECRET' }));
    qq.pushInbound({ peerId: 'u-2', context: 'private', messageId: 'm1', text: 'x' });
    expect(await qq.receive()).toBeNull();
    await expect(qq.send({ occurrenceId: 'o', idempotencyKey: 'k', text: 'x', background: true })).rejects.toThrow(/background/i);
  });
});
