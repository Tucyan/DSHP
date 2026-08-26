import path from 'node:path';

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
  const runtime = path.join(root, 'runtime') + path.sep;
  for (const key of ['dshHome', 'agentsHome', 'plugins', 'skills', 'sessions', 'storage', 'credentials'] as const) {
    const value = normalize(paths[key]);
    if (!value.toLowerCase().startsWith(runtime.toLowerCase())) throw new Error(`${key} must stay inside runtime root`);
  }
  const workspace = normalize(paths.workspace);
  if (!workspace.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('workspace must stay inside runtime root');
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (userHome) {
    const defaults = [path.join(userHome, '.dsh'), path.join(userHome, '.agents')];
    for (const candidate of [paths.dshHome, paths.agentsHome]) {
      if (defaults.some((item) => normalize(item).toLowerCase() === normalize(candidate).toLowerCase())) throw new Error('isolated path must not equal the default home');
    }
  }
  if (!Number.isInteger(paths.webPort) || paths.webPort < 1024 || paths.webPort > 65535) throw new Error('webPort must be between 1024 and 65535');
}

export function launchEnvironment(paths: IsolatedPaths): NodeJS.ProcessEnv {
  validateIsolatedPaths(paths);
  return { ...process.env, DSH_HOME: paths.dshHome, DSH_AGENTS_HOME: paths.agentsHome, DSH_WORKSPACE: paths.workspace };
}

