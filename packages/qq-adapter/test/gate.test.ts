import { describe, expect, it } from 'vitest';
import { parseQqConfig } from '../src/config.js';
import { SingleUserQqGate } from '../src/gate.js';

const cfg = parseQqConfig({ peerId: 'u-1', appId: 'app', appSecretEnv: 'QQ_SECRET' });
describe('QQ single-user gate', () => {
  it('accepts only the configured private peer and drops groups', () => {
    const gate = new SingleUserQqGate(cfg);
    expect(gate.accept({ peerId: 'u-1', context: 'private', text: 'hi', messageId: 'm1' })).toEqual(expect.objectContaining({ type: 'user_message', text: 'hi' }));
    expect(gate.accept({ peerId: 'u-1', context: 'group', groupId: 'g', text: 'hi', messageId: 'm2' })).toBeNull();
    expect(gate.accept({ peerId: 'u-2', context: 'private', text: 'hi', messageId: 'm3' })).toBeNull();
  });
  it('does not include secrets in binding or trace-safe metadata', () => {
    const gate = new SingleUserQqGate(cfg);
    expect(JSON.stringify(gate.binding())).not.toContain('secret');
    expect(gate.binding()).toEqual({ peerId: 'u-1', context: 'private' });
  });
  it('rejects loose or secret-bearing configuration', () => {
    expect(() => parseQqConfig({ peerId: 'u', appId: 'a', appSecret: 'plain' })).toThrow();
    expect(() => parseQqConfig({ peerId: 'u', appId: 'a', appSecretEnv: 'x', extra: true })).toThrow();
  });
});
