import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { appendJsonl } from '@personal-growth/shared';
import { buildIndex } from './index-builder.js';
import { buildProfile } from './profile-builder.js';
import { pathForMemory, workspacePaths, type WorkspacePaths } from './paths.js';
import { ProposalSchema, type MemoryProposal } from './proposal.js';
import { MemoryReader, MemoryMetadataSchema, renderMemoryDocument } from './reader.js';
import { RevisionSchema, type RevisionRecord } from './revision.js';
import { CursorConsolidator, type CompressorPort, type ConversationEvent, type HistoryRecord } from './consolidator.js';

export interface MemoryServiceOptions { workspace?: string; workspaceRoot?: string; workspaceDir?: string; paths?: WorkspacePaths; actor?: string; clock?: () => string; compressor?: CompressorPort; }
export interface MutationResult { accepted: boolean; action: MemoryProposal['action']; path?: string; revision?: RevisionRecord; trace: { result: string; reason?: string }; }

export class MemoryService {
  readonly paths: WorkspacePaths;
  readonly reader: MemoryReader;
  private readonly actor: string;
  private readonly clock: () => string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly consolidator?: CursorConsolidator;

  constructor(options: MemoryServiceOptions = {}) {
    this.paths = options.paths ?? workspacePaths(options.workspaceRoot ?? options.workspaceDir ?? options.workspace ?? process.cwd());
    this.reader = new MemoryReader(this.paths);
    this.actor = options.actor ?? 'personal-memory';
    this.clock = options.clock ?? (() => new Date().toISOString());
    if (options.compressor) this.consolidator = new CursorConsolidator({ paths: this.paths, compressor: options.compressor, clock: this.clock });
  }

  list(category?: Parameters<MemoryReader['list']>[0]) { return this.reader.list(category); }
  read(path: string) { return this.reader.read(path); }
  search(query: string, limit?: number) { return this.reader.search(query, limit); }
  async readProfile(): Promise<string> { try { return await readFile(this.paths.profile, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }
  async readIndex(): Promise<string> { try { return await readFile(this.paths.index, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }
  consume(events: readonly ConversationEvent[]): Promise<HistoryRecord | null> { if (!this.consolidator) return Promise.reject(new Error('No compressor is configured')); return this.consolidator.consume(events); }
  consolidate(events: readonly ConversationEvent[]): Promise<HistoryRecord | null> { return this.consume(events); }

  apply(proposal: MemoryProposal): Promise<MutationResult> {
    const parsed = ProposalSchema.parse(proposal);
    const operation = this.queue.then(() => this.applyNow(parsed));
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  applyProposal(proposal: MemoryProposal): Promise<MutationResult> { return this.apply(proposal); }

  async rememberExplicit(input: ExplicitMemoryInput | string): Promise<MutationResult> {
    const proposal = await this.explicitProposal(input);
    return this.apply(proposal);
  }

  private async explicitProposal(input: ExplicitMemoryInput | string): Promise<MemoryProposal> {
    if (typeof input === 'string') {
      const summary = input.trim().slice(0, 80) || 'Explicit memory';
      return ProposalSchema.parse({ action: 'CREATE', path: `contexts/${slugify(summary)}.md`, summary, content: input.trim(), sourceEvidence: ['explicit:user'], importance: 'high', frequency: 'normal' });
    }
    const path = input.path ?? `contexts/${slugify(input.summary)}.md`;
    let expectedHash = input.expectedHash;
    if (!expectedHash) { try { expectedHash = (await this.reader.read(path)).hash; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    return ProposalSchema.parse({ action: expectedHash ? 'UPDATE' : 'CREATE', ...input, path, sourceEvidence: input.sourceEvidence ?? ['explicit:user'], expectedHash });
  }

  private async applyNow(proposal: MemoryProposal): Promise<MutationResult> {
    if (proposal.action === 'IGNORE') return { accepted: true, action: 'IGNORE', path: proposal.path, trace: { result: 'ignored', reason: proposal.reason } };
    const source = proposal.sourceEvidence;
    if (proposal.action === 'CREATE') {
      if (await this.exists(proposal.path)) throw new Error(`Memory already exists: ${proposal.path}`);
      const raw = await this.writeNew(proposal.path, proposal.summary, proposal.content, source, proposal.importance, proposal.frequency);
      return this.commitRevision('CREATE', proposal.path, source, undefined, raw);
    }
    const current = await this.reader.read(proposal.path);
    if ('expectedHash' in proposal && current.hash !== proposal.expectedHash) throw new Error(`Stale memory proposal for ${proposal.path}`);
    if (proposal.action === 'UPDATE') {
      const mergedSources = [...new Set([...current.metadata.sources, ...source])];
      const raw = await this.writeNew(proposal.path, proposal.summary, proposal.content, mergedSources, proposal.importance ?? current.metadata.importance, proposal.frequency ?? current.metadata.frequency, current.metadata.createdAt);
      return this.commitRevision('UPDATE', proposal.path, source, current.raw, raw);
    }
    if (proposal.action === 'MERGE') {
      if (proposal.path === proposal.targetPath) throw new Error('Cannot merge a memory document into itself');
      const target = await this.reader.read(proposal.targetPath);
      const mergedSources = [...new Set([...current.metadata.sources, ...target.metadata.sources, ...source])];
      const raw = await this.writeNew(proposal.targetPath, proposal.summary, proposal.content, mergedSources, proposal.importance ?? target.metadata.importance, proposal.frequency ?? target.metadata.frequency, target.metadata.createdAt);
      await this.moveToArchive(proposal.path);
      return this.commitRevision('MERGE', proposal.targetPath, source, target.raw, raw);
    }
    if (proposal.path.startsWith('archive/')) throw new Error('Memory is already archived');
    const archivedPath = `archive/${proposal.path.split('/').at(-1)}`;
    const archiveRaw = await this.writeNew(archivedPath, proposal.summary, proposal.content, [...new Set([...current.metadata.sources, ...source])], 'normal', 'normal', current.metadata.createdAt);
    await rm(pathForMemory(this.paths, proposal.path), { force: true });
    return this.commitRevision('ARCHIVE', archivedPath, source, current.raw, archiveRaw);
  }

  private async exists(path: string): Promise<boolean> { try { await this.reader.read(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
  private async writeNew(path: string, summary: string, content: string, sources: string[], importance = 'normal', frequency = 'normal', createdAt?: string): Promise<string> {
    const metadata = MemoryMetadataSchema.parse({ category: path.split('/')[0], summary, importance, frequency, sources, createdAt: createdAt ?? this.clock(), updatedAt: this.clock() });
    const raw = renderMemoryDocument(metadata, content);
    const target = pathForMemory(this.paths, path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try { await writeFile(temporary, raw, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
    return raw;
  }
  private async moveToArchive(path: string): Promise<void> { const current = await this.reader.read(path); await this.writeNew(`archive/${path.split('/').at(-1)}`, current.metadata.summary, current.content, current.metadata.sources, 'normal', 'normal', current.metadata.createdAt); await rm(pathForMemory(this.paths, path), { force: true }); }
  private async commitRevision(action: 'CREATE' | 'UPDATE' | 'MERGE' | 'ARCHIVE', path: string, source: string[], beforeRaw: string | undefined, afterRaw: string): Promise<MutationResult> {
    const beforeHash = beforeRaw ? hash(beforeRaw) : undefined;
    const afterHash = hash(afterRaw);
    const revision = RevisionSchema.parse({ revisionId: `${this.clock()}-${afterHash.slice(0, 12)}`, time: this.clock(), actor: this.actor, action, path, source, beforeHash, afterHash });
    await appendJsonl(this.paths.revisions, revision);
    await buildIndex(this.paths); await buildProfile(this.paths);
    return { accepted: true, action, path, revision, trace: { result: 'applied' } };
  }
}

export interface ExplicitMemoryInput { path?: string; summary: string; content: string; sourceEvidence?: string[]; importance?: 'low' | 'normal' | 'high'; frequency?: 'low' | 'normal' | 'high'; expectedHash?: string; }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function slugify(value: string): string { return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'explicit-memory'; }
