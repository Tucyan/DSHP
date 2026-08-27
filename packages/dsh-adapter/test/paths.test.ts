import { describe, expect, it } from 'vitest';
import { resolveIsolatedPaths, validateIsolatedPaths, validateIsolatedPathsAsync } from '../src/paths.js';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('isolated DSH paths', () => {
  it('computes project-local absolute paths and rejects default homes', () => {
    const p = resolveIsolatedPaths('C:/work/project');
    expect(p.dshHome).toBe('C:\\work\\project\\runtime\\dsh-home');
    expect(p.agentsHome).toBe('C:\\work\\project\\runtime\\agents-home');
    expect(p.workspace).toBe('C:\\work\\project\\workspace');
    expect(() => validateIsolatedPaths({ ...p, dshHome: 'C:\\Users\\me\\.dsh' })).toThrow(/default/i);
    expect(() => validateIsolatedPaths({ ...p, agentsHome: 'C:\\Users\\me\\.agents' })).toThrow(/default/i);
  });
  it('refuses a path outside runtime root', () => {
    const p = resolveIsolatedPaths('C:/work/project');
    expect(() => validateIsolatedPaths({ ...p, workspace: 'C:\\work\\other' })).toThrow(/runtime root/i);
  });
  it('rejects an existing runtime symlink that escapes the repository', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-paths-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'pga-outside-'));
    try { await symlink(outside, path.join(root, 'runtime'), 'junction'); } catch { return; }
    await expect(validateIsolatedPathsAsync(resolveIsolatedPaths(root))).rejects.toThrow(/symlink|outside|canonical/i);
  });
  it('rejects a symlink or junction that points to another internal location', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-paths-internal-'));
    const runtime = path.join(root, 'runtime'); const target = path.join(runtime, 'inside'); const link = path.join(runtime, 'dsh-home');
    const { mkdir } = await import('node:fs/promises'); await mkdir(target, { recursive: true });
    try { await symlink(target, link, 'junction'); } catch { return; }
    await expect(validateIsolatedPathsAsync(resolveIsolatedPaths(root))).rejects.toThrow(/symlink|junction|canonical/i);
  });
});
