import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveIsolatedPaths, validateIsolatedPathsAsync, type IsolatedPaths } from '@personal-growth/dsh-adapter';

export interface BootstrapOptions { repoRoot: string; webPort?: number; soul?: string; mission?: string; }
export interface BootstrappedRuntime { paths: IsolatedPaths; }
const DEFAULT_SOUL = '# Personal Growth Agent\n\nYou are a private, single-user growth companion.\n\n- Respect the user boundary and never invent personal facts.\n- Treat Memory as semantic truth and data as operational evidence.\n- Foreground contact may be NOOP; background work is hidden and never sends messages.\n';
const DEFAULT_AGENT = '# Mission\n\nHelp one fixed user understand goals, turn reflection into action, and improve support over time.\n\n## Boundaries\n\n- Only the configured QQ peer may interact with this instance.\n- Memory changes go through MemoryService proposals. PROFILE.md is derived.\n- Skill drafts require validation; plugin proposals require human approval and are never installed automatically.\n';

async function createIfMissing(filePath: string, value: string): Promise<void> {
  try { await readFile(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await writeFile(filePath, value, { encoding: 'utf8', flag: 'wx' }); }
}

export async function bootstrapRuntime(options: BootstrapOptions): Promise<BootstrappedRuntime> {
  const paths = resolveIsolatedPaths(options.repoRoot, options.webPort ?? 3180);
  await validateIsolatedPathsAsync(paths);
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.workspace, { recursive: true });
  for (const directory of [paths.dshHome, paths.agentsHome, paths.plugins, paths.skills, paths.sessions, paths.storage, paths.credentials]) await mkdir(directory, { recursive: true });
  await createIfMissing(path.join(paths.workspace, 'SOUL.md'), options.soul ?? DEFAULT_SOUL);
  await createIfMissing(path.join(paths.workspace, 'AGENT.md'), options.mission ?? DEFAULT_AGENT);
  return { paths };
}
