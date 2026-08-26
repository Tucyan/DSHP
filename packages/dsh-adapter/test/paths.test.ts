import { describe, expect, it } from 'vitest';
import { resolveIsolatedPaths, validateIsolatedPaths } from '../src/paths.js';

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
});
