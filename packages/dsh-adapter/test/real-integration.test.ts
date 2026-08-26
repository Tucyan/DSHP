import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTencentQqProfilePatch, TENCENT_QQ_ENV } from '../../qq-adapter/src/tencent.js';

describe('pinned live integration contract', () => {
  it('wires the published Tencent bundle through its documented profile patch', () => {
    const patch = buildTencentQqProfilePatch('u-1');
    expect(patch).toContain("@tencent-connect/dsh-qqbot");
    expect(TENCENT_QQ_ENV.appId).toBe('QQBOT_APPID');
    expect(TENCENT_QQ_ENV.appSecret).toBe('QQBOT_SECRET');
    expect(patch).toContain('groupMode: disabled');
    expect(patch).toContain('c2cAllow: ["u-1"]');
    expect(patch).not.toContain('- insert:');
    expect(patch.match(/- id: im-qqbot/g)?.length).toBe(1);
  });
  it('quotes numeric peers and rejects controls', async () => {
    const { buildTencentQqProfilePatch } = await import('../../qq-adapter/src/tencent.js');
    expect(buildTencentQqProfilePatch('123')).toContain('c2cAllow: ["123"]');
    expect(() => buildTencentQqProfilePatch('12\n3')).toThrow(/control/i);
    expect(() => buildTencentQqProfilePatch('12\\3')).toThrow(/safe|control/i);
  });
  it('resolves the pinned published bundle entry without starting a credential flow', async () => {
    const bundle = await import('@tencent-connect/dsh-qqbot');
    expect(bundle.name).toBe('im-qqbot');
    expect(typeof bundle.apply).toBe('function');
    expect(bundle.Config).toBeDefined();
  });
  it('proves the real include patch semantics yield one secured Tencent row', async () => {
    const store = [path.resolve('node_modules/.pnpm'), path.resolve('../../node_modules/.pnpm')].find((candidate) => existsSync(candidate));
    if (!store) throw new Error('cached pnpm store is required for this contract test');
    const includeDir = readdirSync(store).map((name) => path.join(store, name, 'node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js')).find((candidate) => existsSync(candidate));
    if (!includeDir) throw new Error('cached cordis-plugin-include is required for this contract test');
    const { applyEntryPatches } = await import(pathToFileURL(includeDir).href);
    const warnings: string[] = [];
    const base = [{ id: 'base', name: 'base', group: true, config: [] }];
    const official = { insert: [{ id: 'im-qqbot', name: '@tencent-connect/dsh-qqbot', config: { access: { c2cMode: 'open', groupMode: 'open' } } }] };
    const overlay = { id: 'im-qqbot', name: '@tencent-connect/dsh-qqbot', disabled: false, config: { access: { c2cMode: 'allowlist', c2cAllow: ['123'], groupMode: 'disabled', groupAllow: [] } } };
    const result = applyEntryPatches(base, [official, overlay], (message: string) => warnings.push(message));
    const rows = result as Array<{ id?: string; name?: string; disabled?: boolean; config?: unknown }>;
    expect(warnings).toEqual([]);
    expect(rows.filter((row: { id?: string }) => row.id === 'im-qqbot')).toHaveLength(1);
    expect(rows.find((row: { id?: string }) => row.id === 'im-qqbot')).toMatchObject({ name: '@tencent-connect/dsh-qqbot', disabled: false, config: { access: { c2cMode: 'allowlist', c2cAllow: ['123'], groupMode: 'disabled' } } });
  });
});
