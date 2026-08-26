import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('runtime launcher isolation', () => {
  it('computes repository-local paths in dry-run mode without creating files', () => {
    const script = path.resolve('scripts/runtime-config.mjs');
    const result = execFileSync(process.execPath, [script, '--json'], { encoding: 'utf8', env: { ...process.env, PGA_REPO_ROOT: process.cwd() } });
    const config = JSON.parse(result) as { root: string; dshHome: string; agentsHome: string };
    expect(config.root).toBe(path.resolve('.'));
    expect(config.dshHome).toContain(path.join('runtime', 'dsh-home'));
    expect(config.agentsHome).toContain(path.join('runtime', 'agents-home'));
    expect(config.dshHome).not.toBe(path.join(process.env.USERPROFILE ?? '', '.dsh'));
    expect(config.agentsHome).not.toBe(path.join(process.env.USERPROFILE ?? '', '.agents'));
  });
});
