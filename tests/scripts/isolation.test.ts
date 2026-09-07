import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePowerShell } from './powershell.js';

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
    const result = execFileSync(resolvePowerShell(), ['-NoProfile', '-File', script, '-DryRun'], { encoding: 'utf8', env: { ...process.env, PGA_REPO_ROOT: process.cwd() } });
    const launch = JSON.parse(result) as { command: string; cwd: string; args: string[]; env: Record<string, string> };
    expect(launch.command).toBe('corepack');
    expect(launch.cwd).toBe(path.resolve('workspace'));
    expect(launch.args).toEqual(['pnpm@11.7.0', '--filter', '@personal-growth/dsh-adapter', 'exec', 'dsh', 'web', '--patch', path.resolve('config/qq-disabled.patch.yml'), '--port', '3180']);
    for (const key of ['DSH_HOME', 'DSH_AGENTS_HOME', 'PGA_PLUGINS_DIR', 'PGA_SKILLS_DIR', 'PGA_SESSIONS_DIR', 'PGA_STORAGE_DIR', 'PGA_CREDENTIALS_DIR']) expect(launch.env[key]).toContain(path.resolve('runtime').split(path.sep).join(path.sep));
    expect(launch.env.PGA_RUNTIME_ROOT).toBe(path.resolve('.'));
    expect(launch.env.DSH_WORKSPACE).toBe(path.resolve('workspace'));
  });
  it('audits opt-in installation against every local bundle and the pinned Tencent package', () => {
    const script = readFileSync(path.resolve('scripts/install-runtime-bundles.ps1'), 'utf8');
    for (const bundle of ['packages/agent-core', 'packages/personal-memory', 'packages/personal-heartbeat']) {
      expect(script).toContain(bundle);
    }
    expect(script).toContain("@tencent-connect/dsh-qqbot@0.4.0");
    expect(script).toContain('corepack pnpm@11.7.0');
    expect(script).not.toMatch(/&\s+dsh(?:\s|$)/i);
    expect(script).toMatch(/\$patchText\s*=.*render-qq-profile\.mjs/);
    expect(script).toContain('if ($LASTEXITCODE -ne 0)');
    expect(script).toContain('render-qq-profile.mjs');
    expect(script).not.toMatch(/^\s*c2cAllow:\s*\["\$PeerId"\]/m);
    expect(script).toContain('managed QQ profile binding mismatch');
    expect(script.indexOf('$patchText')).toBeLessThan(script.indexOf('dsh plugin --profile web add'));
    expect(script).toContain('corepack pnpm@11.7.0 build');
    expect(script.indexOf('corepack pnpm@11.7.0 build')).toBeLessThan(script.indexOf('render-qq-profile.mjs'));
    expect(script.indexOf('render-qq-profile.mjs')).toBeLessThan(script.indexOf('dsh plugin --profile web add'));
    expect(script).toContain('--disabled');
    expect(script).toContain('$installationSucceeded = $false');
    expect(script).toContain('else { Write-AtomicText $profilePatch $disabledProfile }');
    expect(script.indexOf('Write-AtomicText $profilePatch $disabledProfile')).toBeLessThan(script.indexOf('dsh plugin --profile web add'));
    expect(script.indexOf('finally {', script.indexOf('$installationSucceeded = $false'))).toBeGreaterThan(script.indexOf('$installationSucceeded = $false'));
    const launcher = readFileSync(path.resolve('scripts/start-runtime.ps1'), 'utf8');
    expect(launcher).not.toMatch(/&\s+dsh(?:\s|$)/i);
    expect(launcher).toContain('if ($LASTEXITCODE -ne 0)');
    expect(launcher).toContain('--patch');
    expect(launcher).toContain('qq-disabled.patch.yml');
    expect(launcher).toContain('QQ_PEER_ID');
    expect(launcher).not.toContain('managed QQ profile binding mismatch');
    expect(launcher).toMatch(/exec dsh web --patch \$disabledPatch/);
    expect(launcher).toContain('packages/dsh-host/dist/cli.js');
    const disabledPatch = readFileSync(path.resolve('config/qq-disabled.patch.yml'), 'utf8');
    expect(disabledPatch).toContain('id: im-qqbot');
    expect(disabledPatch).toContain('disabled: true');
  });
});
