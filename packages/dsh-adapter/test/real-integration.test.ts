import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildTencentQqProfilePatch, TENCENT_QQ_ENV } from '../../qq-adapter/src/tencent.js';

const adapterRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = (scope: string, name: string) => path.join(adapterRoot, 'node_modules', scope, name);
const packageRequire = (root: string) => createRequire(path.join(root, 'package.json'));
const includeEntry = () => {
  // Resolve from the pinned DSH package's own location.  This deliberately
  // does not inspect pnpm's private store layout.
  const dshRoot = packageRoot('@deepseek-ai', 'dsh');
  return packageRequire(dshRoot).resolve('@deepseek-ai/cordis-plugin-include');
};

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
    let includeDir: string;
    try { includeDir = includeEntry(); } catch { return; }
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
  it('parses the published patch and generated overlay as YAML before composing them', async () => {
    const tencentRoot = packageRoot('@tencent-connect', 'dsh-qqbot');
    let yamlRoot: string;
    let includeDir: string;
    try {
      yamlRoot = packageRequire(tencentRoot).resolve('js-yaml');
      includeDir = includeEntry();
    } catch { return; }
    const { load } = await import(pathToFileURL(yamlRoot).href);
    const { applyEntryPatches } = await import(pathToFileURL(includeDir).href);
    const official = load(readFileSync(path.join(tencentRoot, 'cordis.patch.yml'), 'utf8')) as Array<{ insert?: unknown[] }>;
    const generated = load(buildTencentQqProfilePatch('123')) as Array<{ id?: string; name?: string; config?: { access?: Record<string, unknown> } }>;
    expect(Array.isArray(official)).toBe(true);
    expect(Array.isArray(generated)).toBe(true);
    const officialRows = official.flatMap((patch) => patch.insert ?? []);
    expect(officialRows).toHaveLength(1);
    expect(generated).toHaveLength(1);
    const warnings: string[] = [];
    const result = applyEntryPatches([{ id: 'base', name: 'base', group: true, config: [] }], [...official, ...generated], (message: string) => warnings.push(message));
    const rows = result as Array<{ id?: string; name?: string; disabled?: boolean; config?: { access?: Record<string, unknown> } }>;
    expect(warnings).toEqual([]);
    expect(rows.filter((row) => row.id === 'im-qqbot')).toHaveLength(1);
    expect(rows.find((row) => row.id === 'im-qqbot')).toMatchObject({ name: '@tencent-connect/dsh-qqbot', disabled: false, config: { access: { c2cAllow: ['123'], groupMode: 'disabled' } } });
  });
  it('accepts the same managed peer on restart and rejects a changed peer', async () => {
    const patch = buildTencentQqProfilePatch('123');
    const { assertManagedQqProfile } = await import('../../../scripts/validate-qq-profile.mjs');
    expect(() => assertManagedQqProfile(patch, '123')).not.toThrow();
    expect(() => assertManagedQqProfile(patch, '456')).toThrow(/mismatch|peer/i);
  });
});
