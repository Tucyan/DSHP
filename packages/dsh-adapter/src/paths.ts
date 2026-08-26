import path from 'node:path';
import fs from 'node:fs/promises';

export interface IsolatedPaths {
  root: string;
  dshHome: string;
  agentsHome: string;
  workspace: string;
  plugins: string;
  skills: string;
  sessions: string;
  storage: string;
  credentials: string;
  webPort: number;
}

const normalize = (value: string) => path.resolve(value);

export function resolveIsolatedPaths(repoRoot: string, webPort = 3180): IsolatedPaths {
  const root = normalize(repoRoot);
  const runtime = path.join(root, 'runtime');
  return {
    root,
    dshHome: path.join(runtime, 'dsh-home'),
    agentsHome: path.join(runtime, 'agents-home'),
    workspace: path.join(root, 'workspace'),
    plugins: path.join(runtime, 'plugins'),
    skills: path.join(runtime, 'skills'),
    sessions: path.join(runtime, 'sessions'),
    storage: path.join(runtime, 'storage'),
    credentials: path.join(runtime, 'credentials'),
    webPort,
  };
}

export function validateIsolatedPaths(paths: IsolatedPaths): void {
  const root = normalize(paths.root);
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (userHome) {
    const defaults = [path.join(userHome, '.dsh'), path.join(userHome, '.agents')];
    for (const candidate of [paths.dshHome, paths.agentsHome]) {
      if (defaults.some((item) => normalize(item).toLowerCase() === normalize(candidate).toLowerCase())) throw new Error('isolated path must not equal the default home');
    }
  }
  for (const candidate of [paths.dshHome, paths.agentsHome]) {
    const name = path.basename(normalize(candidate)).toLowerCase();
    if (name === '.dsh' || name === '.agents') throw new Error('isolated path must not equal the default home');
  }
  const runtime = path.join(root, 'runtime') + path.sep;
  for (const key of ['dshHome', 'agentsHome', 'plugins', 'skills', 'sessions', 'storage', 'credentials'] as const) {
    const value = normalize(paths[key]);
    if (!value.toLowerCase().startsWith(runtime.toLowerCase())) throw new Error(`${key} must stay inside runtime root`);
  }
  const workspace = normalize(paths.workspace);
  if (!workspace.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('workspace must stay inside runtime root');
  if (!Number.isInteger(paths.webPort) || paths.webPort < 1024 || paths.webPort > 65535) throw new Error('webPort must be between 1024 and 65535');
}

export function launchEnvironment(paths: IsolatedPaths): NodeJS.ProcessEnv {
  validateIsolatedPaths(paths);
  return { ...process.env, DSH_HOME: paths.dshHome, DSH_AGENTS_HOME: paths.agentsHome, DSH_WORKSPACE: paths.workspace };
}

async function nearestRealPath(value: string): Promise<string> {
  let current = value;
  while (true) {
    try { return await fs.realpath(current); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && path.dirname(current) !== current) { current = path.dirname(current); continue; }
      throw error;
    }
  }
}

export async function validateIsolatedPathsAsync(paths: IsolatedPaths): Promise<void> {
  validateIsolatedPaths(paths);
  const root = await nearestRealPath(paths.root);
  const candidates = [paths.dshHome, paths.agentsHome, paths.workspace, paths.plugins, paths.skills, paths.sessions, paths.storage, paths.credentials];
  for (const candidate of candidates) {
    const target = normalize(candidate); const ancestor = await nearestRealPath(target); const relative = path.relative(root, ancestor);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('isolated path resolves outside repository');
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('isolated path must not be a symlink'); } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
}
