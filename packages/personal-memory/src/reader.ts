import { readFile, readdir } from 'node:fs/promises';
import { relative } from 'node:path';
import { z } from 'zod';
import { MEMORY_CATEGORIES, type MemoryCategory, pathForMemory, workspacePaths, type WorkspacePaths } from './paths.js';

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
  constructor(workspaceOrPaths: string | WorkspacePaths = process.cwd()) { this.paths = typeof workspaceOrPaths === 'string' ? workspacePaths(workspaceOrPaths) : workspaceOrPaths; }

  async list(category?: MemoryCategory): Promise<MemoryDocument[]> {
    const categories = category ? [category] : [...MEMORY_CATEGORIES];
    const results: MemoryDocument[] = [];
    for (const current of categories) {
      const dir = this.paths.categories[current];
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
    const raw = await readFile(path, 'utf8');
    const parsed = parseMemoryDocument(raw);
    if (parsed.metadata.category !== memoryPath.split('/')[0]) throw new Error('Memory metadata category mismatch');
    return { path: memoryPath, ...parsed, raw, hash: await hashText(raw) };
  }

  async search(query: string, limit = 20): Promise<MemoryDocument[]> {
    if (!query.trim()) return [];
    const needle = query.toLocaleLowerCase();
    const documents = await this.list();
    return documents.filter((document) => `${document.metadata.summary}\n${document.content}`.toLocaleLowerCase().includes(needle)).slice(0, Math.max(0, limit));
  }
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
