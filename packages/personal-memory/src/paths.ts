import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export const MEMORY_CATEGORIES = ['preferences', 'contexts', 'decisions', 'events', 'archive'] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

export interface WorkspacePaths {
  root: string;
  profile: string;
  memory: string;
  index: string;
  history: string;
  state: string;
  revisions: string;
  categories: Record<MemoryCategory, string>;
}

export function workspacePaths(workspaceRoot = process.cwd()): WorkspacePaths {
  const root = resolve(workspaceRoot);
  const memory = join(root, 'memory');
  const categories = Object.fromEntries(MEMORY_CATEGORIES.map((category) => [category, join(memory, category)])) as Record<MemoryCategory, string>;
  return { root, profile: join(root, 'PROFILE.md'), memory, index: join(memory, 'INDEX.md'), history: join(memory, 'history.jsonl'), state: join(memory, 'state.json'), revisions: join(memory, 'revisions.jsonl'), categories };
}

export function assertMemoryPath(value: string): string {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')) throw new Error('Memory path must be a relative POSIX Markdown path');
  const normalized = normalize(value).replaceAll('\\', '/');
  if (normalized !== value || normalized.startsWith('../') || normalized === '..' || normalized.includes('/../') || normalized.startsWith('/')) throw new Error('Memory path traversal is not allowed');
  const parts = normalized.split('/');
  const basename = parts.at(-1)!.toLocaleLowerCase();
  const reserved = new Set(['profile.md', 'index.md', 'history.jsonl', 'state.json', 'revisions.jsonl']);
  if (parts.length < 2 || !(MEMORY_CATEGORIES as readonly string[]).includes(parts[0]) || !basename.endsWith('.md') || reserved.has(basename)) throw new Error('Only category Markdown memory paths are allowed');
  return normalized;
}

export function pathForMemory(paths: WorkspacePaths, memoryPath: string): string {
  const safe = assertMemoryPath(memoryPath);
  const [category, ...rest] = safe.split('/');
  const candidate = resolve(paths.categories[category as MemoryCategory], ...rest);
  const root = resolve(paths.categories[category as MemoryCategory]);
  const rel = relative(root, candidate);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Memory path traversal is not allowed');
  return candidate;
}
