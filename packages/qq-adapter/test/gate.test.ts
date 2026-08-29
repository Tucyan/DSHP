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
  it('rejects missing, oversized, and control-character message ids', () => {
    const gate = new SingleUserQqGate(cfg);
    expect(gate.accept({ peerId: 'u-1', context: 'private', messageId: '', text: 'hello' })).toBeNull();
    expect(gate.accept({ peerId: 'u-1', context: 'private', messageId: 'x'.repeat(257), text: 'hello' })).toBeNull();
    expect(gate.accept({ peerId: 'u-1', context: 'private', messageId: 'bad\u0000id', text: 'hello' })).toBeNull();
  });
  it('rejects malformed, out-of-range, and oversized inbound timestamps/text', () => {
    const gate = new SingleUserQqGate(cfg, () => '2026-08-27T10:00:00.000Z');
    expect(gate.accept({ peerId: 'u-1', context: 'private', messageId: 'bad-time', text: 'hello', at: 'not-a-date' })).toBeNull();
    expect(gate.accept({ peerId: 'u-1', context: 'private', messageId: 'old-time', text: 'hello', at: '1900-01-01T00:00:00.000Z' })).toBeNull();
    expect(gate.accept({ peerId: 'u-1', context: 'private', messageId: 'large-text', text: 'x'.repeat(4097), at: '2026-08-27T10:00:00.000Z' })).toBeNull();
  });
});
