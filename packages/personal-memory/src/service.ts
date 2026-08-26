import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from '@personal-growth/shared';
import { renderIndex } from './index-builder.js';
import { renderProfile } from './profile-builder.js';
import { pathForMemory, workspacePaths, type WorkspacePaths } from './paths.js';
import { ProposalSchema, type MemoryProposal } from './proposal.js';
import { MemoryReader, MemoryMetadataSchema, renderMemoryDocument } from './reader.js';
import { RevisionSchema, type RevisionRecord } from './revision.js';
import { CursorConsolidator, type CompressorPort, type ConversationEvent, type HistoryRecord } from './consolidator.js';

export interface MemoryServiceOptions { workspace?: string; workspaceRoot?: string; workspaceDir?: string; paths?: WorkspacePaths; actor?: string; clock?: () => string; compressor?: CompressorPort; }
export interface MutationResult { accepted: boolean; action: MemoryProposal['action']; path?: string; revision?: RevisionRecord; trace: { result: string; reason?: string }; }
const PendingSchema = z.object({ action: z.enum(['MERGE', 'ARCHIVE']), path: z.string().min(1), targetPath: z.string().min(1), writePath: z.string().min(1).optional(), source: z.array(z.string().min(1)).min(1), beforeHash: z.string().regex(/^[a-f0-9]{64}$/i), targetBeforeHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(), archiveHash: z.string().regex(/^[a-f0-9]{64}$/i), afterHash: z.string().regex(/^[a-f0-9]{64}$/i), afterRaw: z.string().min(1), archiveRaw: z.string().min(1), revision: RevisionSchema }).strict();
const StateSchema = z.object({ memoryCursor: z.record(z.string(), z.number().int().nonnegative()).default({}), pendingMutation: PendingSchema.optional() }).passthrough();
type State = z.infer<typeof StateSchema>;

export class MemoryService {
  readonly paths: WorkspacePaths;
  readonly reader: MemoryReader;
  private readonly actor: string;
  private readonly clock: () => string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  private readonly consolidator?: CursorConsolidator;

  constructor(options: MemoryServiceOptions = {}) {
    this.paths = options.paths ?? workspacePaths(options.workspaceRoot ?? options.workspaceDir ?? options.workspace ?? process.cwd());
    this.reader = new MemoryReader(this.paths);
    this.actor = options.actor ?? 'personal-memory';
    this.clock = options.clock ?? (() => new Date().toISOString());
    if (options.compressor) this.consolidator = new CursorConsolidator({ paths: this.paths, compressor: options.compressor, clock: this.clock });
    this.ready = this.recoverPending();
  }

  list(category?: Parameters<MemoryReader['list']>[0]) { return this.ready.then(() => this.reader.list(category)); }
  read(path: string) { return this.ready.then(() => this.reader.read(path)); }
  search(query: string, limit?: number) { return this.ready.then(() => this.reader.search(query, limit)); }
  async readProfile(): Promise<string> { await this.ready; try { return await readFile(this.paths.profile, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }
  async readIndex(): Promise<string> { await this.ready; try { return await readFile(this.paths.index, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }
  consume(events: readonly ConversationEvent[]): Promise<HistoryRecord | null> { if (!this.consolidator) return Promise.reject(new Error('No compressor is configured')); return this.consolidator.consume(events); }
  consolidate(events: readonly ConversationEvent[]): Promise<HistoryRecord | null> { return this.consume(events); }

  apply(proposal: MemoryProposal): Promise<MutationResult> {
    const parsed = ProposalSchema.parse(proposal);
    const operation = this.queue.then(async () => { await this.ready; await this.recoverPending(); return this.applyNow(parsed); });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  applyProposal(proposal: MemoryProposal): Promise<MutationResult> { return this.apply(proposal); }

  async rememberExplicit(input: ExplicitMemoryInput | string): Promise<MutationResult> {
    await this.ready;
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
      const raw = renderMemoryDocument(MemoryMetadataSchema.parse({ category: target.metadata.category, summary: proposal.summary, importance: proposal.importance ?? target.metadata.importance, frequency: proposal.frequency ?? target.metadata.frequency, sources: mergedSources, createdAt: target.metadata.createdAt ?? this.clock(), updatedAt: this.clock() }), proposal.content);
      const archiveRaw = this.archiveRaw(current, source);
      const revision = this.makeRevision('MERGE', proposal.targetPath, source, target.raw, raw);
      await this.persistPending({ action: 'MERGE', path: proposal.path, writePath: proposal.targetPath, targetPath: `archive/${proposal.path.split('/').at(-1)}`, source, beforeHash: hash(current.raw), targetBeforeHash: hash(target.raw), archiveHash: hash(archiveRaw), afterHash: hash(raw), afterRaw: raw, archiveRaw, revision });
      await this.completePending();
      return { accepted: true, action: 'MERGE', path: proposal.targetPath, revision, trace: { result: 'applied' } };
    }
    if (proposal.path.startsWith('archive/')) throw new Error('Memory is already archived');
    const archivedPath = `archive/${proposal.path.split('/').at(-1)}`;
    const archiveRaw = this.archiveRaw(current, source);
    const revision = this.makeRevision('ARCHIVE', proposal.path, source, current.raw, archiveRaw);
    await this.persistPending({ action: 'ARCHIVE', path: proposal.path, targetPath: archivedPath, source, beforeHash: current.hash, archiveHash: hash(archiveRaw), afterHash: hash(archiveRaw), afterRaw: archiveRaw, archiveRaw, revision });
    await this.completePending();
    return { accepted: true, action: 'ARCHIVE', path: proposal.path, revision, trace: { result: 'applied' } };
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
  private async commitRevision(action: 'CREATE' | 'UPDATE' | 'MERGE' | 'ARCHIVE', path: string, source: string[], beforeRaw: string | undefined, afterRaw: string): Promise<MutationResult> {
    const revision = this.makeRevision(action, path, source, beforeRaw, afterRaw);
    await appendJsonl(this.paths.revisions, revision);
    await this.rebuildProjections();
    return { accepted: true, action, path, revision, trace: { result: 'applied' } };
  }
  private makeRevision(action: 'CREATE' | 'UPDATE' | 'MERGE' | 'ARCHIVE', path: string, source: string[], beforeRaw: string | undefined, afterRaw: string): RevisionRecord {
    const beforeHash = beforeRaw ? hash(beforeRaw) : undefined;
    const afterHash = hash(afterRaw);
    return RevisionSchema.parse({ revisionId: `${action.toLocaleLowerCase()}-${path}-${afterHash.slice(0, 16)}`, time: this.clock(), actor: this.actor, action, path, source, beforeHash, afterHash });
  }
  private async readState(): Promise<State> { try { return StateSchema.parse(await readJson(this.paths.state, StateSchema)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { memoryCursor: {} }; throw error; } }
  private async persistPending(pending: z.infer<typeof PendingSchema>): Promise<void> { const state = await this.readState(); state.pendingMutation = pending; await writeJsonAtomic(this.paths.state, state); }
  private async recoverPending(): Promise<void> { const state = await this.readState(); if (!state.pendingMutation) return; await this.completePending(); }
  private async completePending(): Promise<void> {
    const state = await this.readState(); const pending = state.pendingMutation; if (!pending) return;
    const sourcePath = pathForMemory(this.paths, pending.path); const targetPath = pathForMemory(this.paths, pending.targetPath); const writePath = pending.writePath ?? pending.targetPath;
    const sourceExistsBefore = await this.exists(pending.path);
    if (sourceExistsBefore && (await this.reader.read(pending.path)).hash !== pending.beforeHash) throw new Error('Pending mutation source changed');
    if (pending.action === 'MERGE') {
      const targetExists = await this.exists(writePath);
      if (targetExists) {
        const targetHash = (await this.reader.read(writePath)).hash;
        if (targetHash !== pending.afterHash && (!pending.targetBeforeHash || targetHash !== pending.targetBeforeHash)) throw new Error('Pending mutation target changed');
      } else if (pending.targetBeforeHash) {
        throw new Error('Pending mutation target disappeared');
      } else {
        await this.writeRaw(writePath, pending.afterRaw);
      }
      if (targetExists && (await this.reader.read(writePath)).hash === pending.targetBeforeHash) await this.writeRaw(writePath, pending.afterRaw);
    }
    const sourceExists = await this.exists(pending.path); const targetExists = await this.fileExists(pending.targetPath);
    if (sourceExists && !targetExists) { await mkdir(dirname(targetPath), { recursive: true }); await rename(sourcePath, targetPath); }
    else if (sourceExists && targetExists) { if ((await this.rawHashAt(targetPath)) === pending.archiveHash && (pending.action === 'ARCHIVE' || (await this.reader.read(writePath)).hash === pending.afterHash)) await rm(sourcePath, { force: true }); else throw new Error('Pending mutation target conflict'); }
    else if (!sourceExists && !targetExists) throw new Error('Pending mutation lost both source and target');
    if ((await this.rawHashAt(targetPath)) !== pending.archiveHash) await this.writeRaw(pending.targetPath, pending.archiveRaw);
    const revisions = await readJsonl(this.paths.revisions, RevisionSchema);
    if (!revisions.records.some((revision) => revision.revisionId === pending.revision.revisionId)) await appendJsonl(this.paths.revisions, pending.revision);
    await this.rebuildProjections();
    delete state.pendingMutation; await writeJsonAtomic(this.paths.state, state);
  }
  private async writeRaw(path: string, raw: string): Promise<void> { const target = pathForMemory(this.paths, path); await mkdir(dirname(target), { recursive: true }); const temporary = `${target}.${process.pid}.${Date.now()}.tmp`; try { await writeFile(temporary, raw, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; } }
  private async fileExists(path: string): Promise<boolean> { try { await readFile(pathForMemory(this.paths, path)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
  private async rawHashAt(path: string): Promise<string> { return hash(await readFile(path)); }
  private async rebuildProjections(): Promise<void> { const documents = await this.reader.list(); await this.writeProjection(this.paths.index, renderIndex(documents)); await this.writeProjection(this.paths.profile, renderProfile(documents)); }
  private archiveRaw(document: Awaited<ReturnType<MemoryReader['read']>>, additionalSources: readonly string[] = []): string { return renderMemoryDocument(MemoryMetadataSchema.parse({ ...document.metadata, category: 'archive', sources: [...new Set([...document.metadata.sources, ...additionalSources])] }), document.content); }
  private async writeProjection(path: string, value: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${Date.now()}.tmp`; try { await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; } }
}

export interface ExplicitMemoryInput { path?: string; summary: string; content: string; sourceEvidence?: string[]; importance?: 'low' | 'normal' | 'high'; frequency?: 'low' | 'normal' | 'high'; expectedHash?: string; }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function slugify(value: string): string { return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'explicit-memory'; }
