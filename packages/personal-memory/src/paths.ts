import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { lstatSync, realpathSync } from 'node:fs';

export const MEMORY_CATEGORIES = ['preferences', 'contexts', 'decisions', 'events', 'archive'] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];
export const SafeMemoryPathSchema = z.string().superRefine((value, ctx) => { try { assertMemoryPath(value); } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'Invalid memory path' }); } });

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
  const paths = { root, profile: join(root, 'PROFILE.md'), memory, index: join(memory, 'INDEX.md'), history: join(memory, 'history.jsonl'), state: join(memory, 'state.json'), revisions: join(memory, 'revisions.jsonl'), categories };
  validateWorkspacePaths(paths); return paths;
}

export function validateWorkspacePaths(paths: WorkspacePaths): WorkspacePaths {
  if (!paths || typeof paths.root !== 'string' || paths.root !== resolve(paths.root)) throw new Error('Workspace root must be canonical absolute path');
  const canonical = workspaceCanonical(paths.root);
  const fields: Array<[string, string, string]> = [
    ['profile', paths.profile, canonical.profile], ['memory', paths.memory, canonical.memory],
    ['index', paths.index, canonical.index], ['history', paths.history, canonical.history],
    ['state', paths.state, canonical.state], ['revisions', paths.revisions, canonical.revisions],
  ];
  for (const category of MEMORY_CATEGORIES) fields.push([`categories.${category}`, paths.categories[category], canonical.categories[category]]);
  for (const [name, value, expected] of fields) if (resolve(value) !== expected) throw new Error(`Workspace path mismatch: ${name}`);
  assertNoSymlink(paths.root); for (const value of fields.map(([, path]) => path)) assertNoSymlinkIfPresent(value);
  return paths;
}

function workspaceCanonical(rootValue: string) { const root = resolve(rootValue); const memory = join(root, 'memory'); const categories = Object.fromEntries(MEMORY_CATEGORIES.map((category) => [category, join(memory, category)])) as Record<MemoryCategory, string>; return { profile: join(root, 'PROFILE.md'), memory, index: join(memory, 'INDEX.md'), history: join(memory, 'history.jsonl'), state: join(memory, 'state.json'), revisions: join(memory, 'revisions.jsonl'), categories }; }
function assertNoSymlink(path: string): void {
  let current = resolve(path);
  while (true) {
    try { if (lstatSync(current).isSymbolicLink() || realpathSync(current) !== current) throw new Error(`Symlinked workspace root is not allowed: ${current}`); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = resolve(current, '..'); if (parent === current) return; current = parent; }
  }
}
function assertNoSymlinkIfPresent(path: string): void { try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Symlinked workspace component is not allowed: ${path}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }

export function assertMemoryPath(value: string): string {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')) throw new Error('Memory path must be a relative POSIX Markdown path');
  const normalized = normalize(value).replaceAll('\\', '/');
  if (normalized !== value || normalized.startsWith('../') || normalized === '..' || normalized.includes('/../') || normalized.startsWith('/')) throw new Error('Memory path traversal is not allowed');
  const parts = normalized.split('/');
  if (/[^\x20-\x7e]/.test(value) || value.includes(':')) throw new Error('Memory path contains invalid characters');
  const basename = parts.at(-1)!; const lowerBasename = basename.toLocaleLowerCase();
  const devices = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);
  for (const part of parts) { if (/[. ]$/.test(part)) throw new Error('Memory path may not end in dot or space'); if (devices.has(part.toLocaleLowerCase().split('.')[0])) throw new Error('Reserved device name'); }
  const reserved = new Set(['profile.md', 'index.md', 'history.jsonl', 'state.json', 'revisions.jsonl']);
  if (parts.length < 2 || !(MEMORY_CATEGORIES as readonly string[]).includes(parts[0]) || !lowerBasename.endsWith('.md') || reserved.has(lowerBasename)) throw new Error('Only category Markdown memory paths are allowed');
  return normalized;
}

export function pathForMemory(paths: WorkspacePaths, memoryPath: string): string {
  validateWorkspacePaths(paths);
  const safe = assertMemoryPath(memoryPath);
  const [category, ...rest] = safe.split('/');
  const candidate = resolve(paths.categories[category as MemoryCategory], ...rest);
  const root = resolve(paths.categories[category as MemoryCategory]);
  const rel = relative(root, candidate);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Memory path traversal is not allowed');
  return candidate;
}
