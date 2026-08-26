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
  it('captures the real PowerShell dry-run command, cwd, full isolated env and args', () => {
    const script = path.resolve('scripts/start-runtime.ps1');
    const result = execFileSync('pwsh', ['-NoProfile', '-File', script, '-DryRun'], { encoding: 'utf8', env: { ...process.env, PGA_REPO_ROOT: process.cwd() } });
    const launch = JSON.parse(result) as { command: string; cwd: string; args: string[]; env: Record<string, string> };
    expect(launch.command).toBe('dsh');
    expect(launch.cwd).toBe(path.resolve('workspace'));
    expect(launch.args).toEqual(['web', '--port', '3180']);
    for (const key of ['DSH_HOME', 'DSH_AGENTS_HOME', 'PGA_PLUGINS_DIR', 'PGA_SKILLS_DIR', 'PGA_SESSIONS_DIR', 'PGA_STORAGE_DIR', 'PGA_CREDENTIALS_DIR']) expect(launch.env[key]).toContain(path.resolve('runtime').split(path.sep).join(path.sep));
    expect(launch.env.PGA_RUNTIME_ROOT).toBe(path.resolve('.'));
    expect(launch.env.DSH_WORKSPACE).toBe(path.resolve('workspace'));
  });
});
