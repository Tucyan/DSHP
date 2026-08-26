import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { MEMORY_CATEGORIES, type MemoryCategory, pathForMemory, validateWorkspacePaths, workspacePaths, type WorkspacePaths } from './paths.js';

export const MemoryMetadataSchema = z.object({
  category: z.enum(MEMORY_CATEGORIES),
  summary: z.string().min(1),
  importance: z.enum(['low', 'normal', 'high']).default('normal'),
  frequency: z.enum(['low', 'normal', 'high']).default('normal'),
  sources: z.array(z.string().min(1)).default([]),
  createdAt: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
}).strict();
export type MemoryMetadata = z.infer<typeof MemoryMetadataSchema>;

export interface MemoryDocument { path: string; metadata: MemoryMetadata; content: string; raw: string; hash: string; }
const HEADER = /^<!-- personal-memory:v1 (\{.*\}) -->\r?\n?/;

export function renderMemoryDocument(metadata: MemoryMetadata, content: string): string {
  const parsed = MemoryMetadataSchema.parse(metadata);
  return `<!-- personal-memory:v1 ${JSON.stringify(parsed)} -->\n\n${content.trim()}\n`;
}

export function parseMemoryDocument(raw: string): { metadata: MemoryMetadata; content: string } {
  const match = raw.match(HEADER);
  if (!match) throw new Error('Memory document metadata is missing');
  const metadata = MemoryMetadataSchema.parse(JSON.parse(match[1]));
  return { metadata, content: raw.slice(match[0].length).trim() };
}

async function hashText(value: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value).digest('hex');
}

export class MemoryReader {
  readonly paths: WorkspacePaths;
  constructor(workspaceOrPaths: string | WorkspacePaths = process.cwd()) { this.paths = validateWorkspacePaths(typeof workspaceOrPaths === 'string' ? workspacePaths(workspaceOrPaths) : workspaceOrPaths); }

  async list(category?: MemoryCategory): Promise<MemoryDocument[]> {
    const categories = category ? [category] : [...MEMORY_CATEGORIES];
    const results: MemoryDocument[] = [];
    for (const current of categories) {
      const dir = this.paths.categories[current];
      await assertWorkspacePath(this.paths, dir);
      let names: string[];
      try { names = await markdownFiles(dir); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const name of names) results.push(await this.read(`${current}/${name.replaceAll('\\', '/')}`));
    }
    return results;
  }

  async read(memoryPath: string): Promise<MemoryDocument> {
    const path = pathForMemory(this.paths, memoryPath);
    await assertWorkspacePath(this.paths, path);
    const raw = await readFile(path, 'utf8');
    const parsed = parseMemoryDocument(raw);
    if (parsed.metadata.category !== memoryPath.split('/')[0]) throw new Error('Memory metadata category mismatch');
    return { path: memoryPath, ...parsed, raw, hash: await hashText(raw) };
  }

  async search(query: string, limit = 20): Promise<MemoryDocument[]> {
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Search limit must be a positive integer no greater than 100');
    if (!query.trim()) return [];
    const needle = query.toLocaleLowerCase();
    const documents = await this.list();
    return documents.filter((document) => `${document.metadata.summary}\n${document.content}`.toLocaleLowerCase().includes(needle)).slice(0, Math.max(0, limit));
  }
}

export async function assertWorkspacePath(paths: WorkspacePaths, target: string): Promise<void> {
  const workspace = resolve(paths.root);
  const candidates: string[] = [];
  let current = resolve(target);
  const lexical = relative(workspace, current);
  if (lexical.startsWith('..') || isAbsolute(lexical)) throw new Error(`Workspace path escapes root: ${target}`);
  while (current !== workspace) { candidates.push(current); current = dirname(current); }
  candidates.push(workspace);
  for (const candidate of candidates.reverse()) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error(`Symlinked workspace path is not allowed: ${candidate}`);
      const real = await realpath(candidate);
      const relativeReal = relative(workspace, real);
      if (relativeReal.startsWith('..') || resolve(workspace, relativeReal) !== real) throw new Error(`Workspace path escapes root: ${candidate}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

export async function assertOperationalPaths(paths: WorkspacePaths): Promise<void> {
  for (const target of [paths.profile, paths.memory, paths.index, paths.history, paths.state, paths.revisions, `${paths.memory}/.writer.lock`]) await assertWorkspacePath(paths, target);
}

async function markdownFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) output.push(relative(root, full));
    }
  }
  await visit(root);
  return output.sort();
}

export async function list(workspace: string | WorkspacePaths = process.cwd(), category?: MemoryCategory) { return new MemoryReader(workspace).list(category); }
export async function read(workspace: string | WorkspacePaths, memoryPath: string) { return new MemoryReader(workspace).read(memoryPath); }
export async function search(workspace: string | WorkspacePaths, query: string, limit = 20) { return new MemoryReader(workspace).search(query, limit); }
