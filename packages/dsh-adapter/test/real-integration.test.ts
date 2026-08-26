import { describe, expect, it } from 'vitest';
import { buildTencentQqProfilePatch, TENCENT_QQ_ENV } from '../../qq-adapter/src/tencent.js';

describe('pinned live integration contract', () => {
  it('wires the published Tencent bundle through its documented profile patch', () => {
    const patch = buildTencentQqProfilePatch('u-1');
    expect(patch).toContain("@tencent-connect/dsh-qqbot");
    expect(TENCENT_QQ_ENV.appId).toBe('QQBOT_APPID');
    expect(TENCENT_QQ_ENV.appSecret).toBe('QQBOT_SECRET');
    expect(patch).toContain('groupMode: disabled');
    expect(patch).toContain('c2cAllow: ["u-1"]');
  });
  it('quotes numeric peers and rejects controls', async () => {
    const { buildTencentQqProfilePatch } = await import('../../qq-adapter/src/tencent.js');
    expect(buildTencentQqProfilePatch('123')).toContain('c2cAllow: ["123"]');
    expect(() => buildTencentQqProfilePatch('12\n3')).toThrow(/control/i);
  });
  it('resolves the pinned published bundle entry without starting a credential flow', async () => {
    const bundle = await import('@tencent-connect/dsh-qqbot');
    expect(bundle.name).toBe('im-qqbot');
    expect(typeof bundle.apply).toBe('function');
    expect(bundle.Config).toBeDefined();
  });
});
