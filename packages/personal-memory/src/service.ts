import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from '@personal-growth/shared';
import { renderIndex } from './index-builder.js';
import { renderProfile } from './profile-builder.js';
import { SafeMemoryPathSchema, pathForMemory, validateWorkspacePaths, workspacePaths, type WorkspacePaths } from './paths.js';
import { ProposalSchema, type MemoryProposal } from './proposal.js';
import { assertOperationalPaths, assertWorkspacePath, MemoryReader, MemoryMetadataSchema, renderMemoryDocument } from './reader.js';
import { RevisionSchema, type RevisionRecord } from './revision.js';
import { CursorConsolidator, MAX_CONVERSATION_SEQ, type CompressorPort, type ConversationEvent, type HistoryRecord } from './consolidator.js';
import { withWorkspaceLock } from './lock.js';

export interface MemoryServiceOptions { workspace?: string; workspaceRoot?: string; workspaceDir?: string; paths?: WorkspacePaths; actor?: string; clock?: () => string; compressor?: CompressorPort; lockTimeoutMs?: number; }
export interface MutationResult { accepted: boolean; action: MemoryProposal['action']; path?: string; revision?: RevisionRecord; trace: { result: string; reason?: string }; }
const ActivePathSchema = SafeMemoryPathSchema.superRefine((value, ctx) => { if (value.toLowerCase().startsWith('archive/')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pending active path cannot be archived' }); });
const ArchivePathSchema = SafeMemoryPathSchema.superRefine((value, ctx) => { if (!value.toLowerCase().startsWith('archive/')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pending archive path required' }); });
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const DocumentPendingCommon = { path: ActivePathSchema, source: z.array(z.string().min(1)).min(1), afterHash: HashSchema, afterRaw: z.string().min(1), revision: RevisionSchema };
const PendingCommon = { path: ActivePathSchema, targetPath: ArchivePathSchema, source: z.array(z.string().min(1)).min(1), beforeHash: HashSchema, archiveHash: HashSchema, afterHash: HashSchema, afterRaw: z.string().min(1), archiveRaw: z.string().min(1), revision: RevisionSchema };
const PendingSchema = z.union([
  z.object({ action: z.literal('CREATE'), ...DocumentPendingCommon, beforeHash: z.null() }).strict(),
  z.object({ action: z.literal('UPDATE'), ...DocumentPendingCommon, beforeHash: HashSchema }).strict(),
  z.object({ action: z.literal('MERGE'), ...PendingCommon, writePath: ActivePathSchema, targetBeforeHash: HashSchema }).strict(),
  z.object({ action: z.literal('ARCHIVE'), ...PendingCommon, targetBeforeHash: z.null() }).strict(),
]).superRefine((pending, ctx) => {
  if (pending.revision.action !== pending.action) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pending journal revision action mismatch' });
  const revisionPath = pending.action === 'MERGE' ? pending.writePath : pending.path;
  if (pending.revision.path !== revisionPath) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pending journal revision path mismatch' });
  if (pending.afterHash !== hash(pending.afterRaw)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pending afterHash does not match afterRaw' });
  if ((pending.action === 'CREATE' || pending.action === 'UPDATE') && JSON.stringify(pending.revision.source) !== JSON.stringify(pending.source)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Document pending revision source mismatch' });
  if ((pending.action === 'MERGE' || pending.action === 'ARCHIVE') && pending.archiveHash !== hash(pending.archiveRaw)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pending archiveHash does not match archiveRaw' });
  if (pending.action === 'CREATE' && (pending.revision.beforeHash !== null || pending.revision.afterHash !== pending.afterHash)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CREATE revision hash mismatch' });
  if (pending.action === 'UPDATE' && (pending.revision.beforeHash !== pending.beforeHash || pending.revision.afterHash !== pending.afterHash)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'UPDATE revision hash mismatch' });
  if (pending.action === 'ARCHIVE' && (pending.revision.beforeHash !== pending.beforeHash || pending.revision.afterHash !== pending.archiveHash)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ARCHIVE revision hash mismatch' });
  if (pending.action === 'ARCHIVE' && JSON.stringify(pending.revision.source) !== JSON.stringify(pending.source)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ARCHIVE revision source mismatch' });
  if (pending.action === 'MERGE' && (pending.revision.beforeHash !== pending.targetBeforeHash || pending.revision.afterHash !== pending.afterHash || JSON.stringify(pending.revision.source) !== JSON.stringify(pending.source))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MERGE revision relationship mismatch' });
});
const StateSchema = z.object({ memoryCursor: z.record(z.string(), z.number().int().nonnegative().max(MAX_CONVERSATION_SEQ)).default({}), pendingMutation: PendingSchema.optional() }).strict();
type State = z.infer<typeof StateSchema>;

export class MemoryService {
  readonly paths: WorkspacePaths;
  readonly reader: MemoryReader;
  private readonly actor: string;
  private readonly clock: () => string;
  private readonly lockTimeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private ready?: Promise<void>;
  private readonly consolidator?: CursorConsolidator;

  constructor(options: MemoryServiceOptions = {}) {
    this.paths = validateWorkspacePaths(options.paths ?? workspacePaths(options.workspaceRoot ?? options.workspaceDir ?? options.workspace ?? process.cwd()));
    this.reader = new MemoryReader(this.paths);
    this.actor = options.actor ?? 'personal-memory';
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
    if (this.lockTimeoutMs < 30_000 || !Number.isFinite(this.lockTimeoutMs)) throw new Error('Configured workspace lock timeout must be at least 30000ms');
    if (options.compressor) this.consolidator = new CursorConsolidator({ paths: this.paths, compressor: options.compressor, clock: this.clock, lockTimeoutMs: this.lockTimeoutMs });
  }

  /** Startup is owned by the service and begins only when a real operation needs it. */
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      const startup = withWorkspaceLock(this.paths.root, async () => { await assertOperationalPaths(this.paths); await this.recoverPending(); }, this.lockTimeoutMs);
      startup.catch(() => undefined);
      this.ready = startup;
    }
    return this.ready;
  }

  list(category?: Parameters<MemoryReader['list']>[0]) { return this.ensureReady().then(() => withWorkspaceLock(this.paths.root, async () => { await assertOperationalPaths(this.paths); return this.reader.list(category); }, this.lockTimeoutMs), (error) => Promise.reject(error)); }
  read(path: string) { return this.ensureReady().then(() => withWorkspaceLock(this.paths.root, async () => { await assertOperationalPaths(this.paths); return this.reader.read(path); }, this.lockTimeoutMs), (error) => Promise.reject(error)); }
  search(query: string, limit?: number) { return this.ensureReady().then(() => withWorkspaceLock(this.paths.root, async () => { await assertOperationalPaths(this.paths); return this.reader.search(query, limit); }, this.lockTimeoutMs), (error) => Promise.reject(error)); }
  async readProfile(): Promise<string> { await this.ensureReady(); return withWorkspaceLock(this.paths.root, async () => { await assertOperationalPaths(this.paths); try { return await readFile(this.paths.profile, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }, this.lockTimeoutMs); }
  async readIndex(): Promise<string> { await this.ensureReady(); return withWorkspaceLock(this.paths.root, async () => { await assertOperationalPaths(this.paths); try { return await readFile(this.paths.index, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }, this.lockTimeoutMs); }
  consume(events: readonly ConversationEvent[]): Promise<HistoryRecord | null> {
    if (!this.consolidator) return Promise.reject(new Error('No compressor is configured'));
    const operation = this.queue.then(async () => { await this.ensureReady(); await assertOperationalPaths(this.paths); return this.consolidator!.consume(events); });
    this.queue = operation.catch(() => undefined); return operation;
  }
  consolidate(events: readonly ConversationEvent[]): Promise<HistoryRecord | null> { return this.consume(events); }

  async revisions(): Promise<RevisionRecord[]> {
    await this.ensureReady();
    return withWorkspaceLock(this.paths.root, async () => {
      await assertOperationalPaths(this.paths);
      const result = await readJsonl(this.paths.revisions, RevisionSchema);
      if (result.errors.length) throw new Error('Malformed revision ledger');
      return result.records;
    }, this.lockTimeoutMs);
  }

  apply(proposal: MemoryProposal, context?: { actor: string }): Promise<MutationResult> {
    const parsed = ProposalSchema.parse(proposal);
    const actor = context ? z.string().min(1).max(100).regex(/^[\w-]+$/).parse(context.actor) : this.actor;
    const operation = this.queue.then(async () => { await this.ensureReady(); return withWorkspaceLock(this.paths.root, async () => { await assertOperationalPaths(this.paths); await this.recoverPending(); return this.applyNow(parsed, actor); }, this.lockTimeoutMs); });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  applyProposal(proposal: MemoryProposal): Promise<MutationResult> { return this.apply(proposal); }

  async rememberExplicit(input: ExplicitMemoryInput | string): Promise<MutationResult> {
    const operation = this.queue.then(async () => {
      await this.ensureReady();
      return withWorkspaceLock(this.paths.root, async () => {
        await assertOperationalPaths(this.paths);
        await this.recoverPending();
        return this.applyNow(await this.explicitProposal(input));
      }, this.lockTimeoutMs);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
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

  private async applyNow(proposal: MemoryProposal, actor = this.actor): Promise<MutationResult> {
    const revisionLedger = await readJsonl(this.paths.revisions, RevisionSchema);
    if (revisionLedger.errors.length) throw new Error(`Malformed revisions.jsonl: ${revisionLedger.errors.map((error) => error.line).join(',')}`);
    if (proposal.action !== 'IGNORE') {
      const historyEvidence = proposal.sourceEvidence.find((evidence) => evidence.startsWith('history:'));
      const expectedPath = proposal.action === 'MERGE' ? proposal.targetPath : proposal.path;
      if (historyEvidence) {
        const historyRevisions = revisionLedger.records.filter((revision) => revision.source.includes(historyEvidence));
        const proposalEvidence = proposal.sourceEvidence.find((evidence) => evidence.startsWith('proposal:'));
        const batchEvidence = proposal.sourceEvidence.find((evidence) => evidence.startsWith('batch:'));
        if (batchEvidence) {
          const original = ProposalSchema.parse({ ...proposal, sourceEvidence: proposal.sourceEvidence.filter(evidence => !/^(history|proposal|batch):/.test(evidence)) });
          const fingerprint = createHash('sha256').update(JSON.stringify(original)).digest('hex');
          if (!/^batch:[a-f0-9]{64}$/.test(batchEvidence) || proposalEvidence !== `proposal:${fingerprint}` || ['history:', 'proposal:', 'batch:'].some(prefix => proposal.sourceEvidence.filter(item => item.startsWith(prefix)).length !== 1)) throw new Error('Invalid memory batch identity');
        }
        const existing = historyRevisions.find((revision) => revision.action === proposal.action && (revision.path === expectedPath || revision.path === proposal.path) && (!proposalEvidence ? !revision.source.some((evidence) => evidence.startsWith('proposal:')) : revision.source.includes(proposalEvidence)));
        if (existing) return { accepted: true, action: proposal.action, path: existing.path, revision: existing, trace: { result: 'already-applied' } };
        if (historyRevisions.length && (!batchEvidence || historyRevisions.some(revision => !revision.source.includes(batchEvidence) || revision.path.toLowerCase() === proposal.path.toLowerCase() || revision.path.toLowerCase() === expectedPath.toLowerCase()))) throw new Error(`Conflicting memory proposal for ${historyEvidence}`);
      }
    }
    if (proposal.action === 'IGNORE') return { accepted: true, action: 'IGNORE', path: proposal.path, trace: { result: 'ignored', reason: proposal.reason } };
    const source = proposal.sourceEvidence;
    if (proposal.action === 'CREATE') {
      if (await this.exists(proposal.path)) throw new Error(`Memory already exists: ${proposal.path}`);
      const raw = this.buildRaw(proposal.path, proposal.summary, proposal.content, source, proposal.importance, proposal.frequency);
      const revision = this.makeRevision('CREATE', proposal.path, source, undefined, raw, actor);
      await this.persistPending({ action: 'CREATE', path: proposal.path, source, beforeHash: null, afterHash: hash(raw), afterRaw: raw, revision }); await this.completePending();
      return { accepted: true, action: 'CREATE', path: proposal.path, revision, trace: { result: 'applied' } };
    }
    const current = await this.reader.read(proposal.path);
    if ('expectedHash' in proposal && current.hash !== proposal.expectedHash) throw new Error(`Stale memory proposal for ${proposal.path}`);
    if (proposal.action === 'UPDATE') {
      const mergedSources = [...new Set([...current.metadata.sources, ...source])];
      const raw = this.buildRaw(proposal.path, proposal.summary, proposal.content, mergedSources, proposal.importance ?? current.metadata.importance, proposal.frequency ?? current.metadata.frequency, current.metadata.createdAt);
      const revision = this.makeRevision('UPDATE', proposal.path, source, current.raw, raw, actor);
      await this.persistPending({ action: 'UPDATE', path: proposal.path, source, beforeHash: current.hash, afterHash: hash(raw), afterRaw: raw, revision }); await this.completePending();
      return { accepted: true, action: 'UPDATE', path: proposal.path, revision, trace: { result: 'applied' } };
    }
    if (proposal.action === 'MERGE') {
      if (proposal.path === proposal.targetPath) throw new Error('Cannot merge a memory document into itself');
      const target = await this.reader.read(proposal.targetPath);
      const mergedSources = [...new Set([...current.metadata.sources, ...target.metadata.sources, ...source])];
      const raw = renderMemoryDocument(MemoryMetadataSchema.parse({ category: target.metadata.category, summary: proposal.summary, importance: proposal.importance ?? target.metadata.importance, frequency: proposal.frequency ?? target.metadata.frequency, sources: mergedSources, createdAt: target.metadata.createdAt ?? this.clock(), updatedAt: this.clock() }), proposal.content);
      const archiveRaw = this.archiveRaw(current, source);
      const revision = this.makeRevision('MERGE', proposal.targetPath, source, target.raw, raw, actor);
      await this.persistPending({ action: 'MERGE', path: proposal.path, writePath: proposal.targetPath, targetPath: `archive/${proposal.path.split('/').at(-1)}`, source, beforeHash: hash(current.raw), targetBeforeHash: hash(target.raw), archiveHash: hash(archiveRaw), afterHash: hash(raw), afterRaw: raw, archiveRaw, revision });
      await this.completePending();
      return { accepted: true, action: 'MERGE', path: proposal.targetPath, revision, trace: { result: 'applied' } };
    }
    if (proposal.path.startsWith('archive/')) throw new Error('Memory is already archived');
    const archivedPath = `archive/${proposal.path.split('/').at(-1)}`;
    const archiveRaw = this.archiveRaw(current, source);
    const revision = this.makeRevision('ARCHIVE', proposal.path, source, current.raw, archiveRaw, actor);
    await this.persistPending({ action: 'ARCHIVE', path: proposal.path, targetPath: archivedPath, targetBeforeHash: null, source, beforeHash: current.hash, archiveHash: hash(archiveRaw), afterHash: hash(archiveRaw), afterRaw: archiveRaw, archiveRaw, revision });
    await this.completePending();
    return { accepted: true, action: 'ARCHIVE', path: proposal.path, revision, trace: { result: 'applied' } };
  }

  private async exists(path: string): Promise<boolean> { try { await this.reader.read(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
  private buildRaw(path: string, summary: string, content: string, sources: string[], importance = 'normal', frequency = 'normal', createdAt?: string): string {
    const metadata = MemoryMetadataSchema.parse({ category: path.split('/')[0], summary, importance, frequency, sources, createdAt: createdAt ?? this.clock(), updatedAt: this.clock() });
    return renderMemoryDocument(metadata, content);
  }
  private makeRevision(action: 'CREATE' | 'UPDATE' | 'MERGE' | 'ARCHIVE', path: string, source: string[], beforeRaw: string | undefined, afterRaw: string, actor = this.actor): RevisionRecord {
    const beforeHash = beforeRaw ? hash(beforeRaw) : null;
    const afterHash = hash(afterRaw);
    return RevisionSchema.parse({ revisionId: `${action.toLocaleLowerCase()}-${path}-${afterHash.slice(0, 16)}`, time: this.clock(), actor, action, path, source, beforeHash, afterHash });
  }
  private async readState(): Promise<State> { await assertOperationalPaths(this.paths); try { return StateSchema.parse(await readJson(this.paths.state, StateSchema)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { memoryCursor: {} }; throw error; } }
  private async persistPending(pending: z.infer<typeof PendingSchema>): Promise<void> { const state = await this.readState(); state.pendingMutation = pending; await assertWorkspacePath(this.paths, this.paths.state); await writeJsonAtomic(this.paths.state, state); }
  private async recoverPending(): Promise<void> { const state = await this.readState(); if (!state.pendingMutation) return; await this.completePending(); }
  private async completePending(): Promise<void> {
    const state = await this.readState(); const pending = state.pendingMutation; if (!pending) return;
    if (pending.action === 'CREATE' || pending.action === 'UPDATE') {
      const target = pathForMemory(this.paths, pending.path); const exists = await this.fileExists(pending.path);
      if (pending.action === 'CREATE') {
        if (exists && (await this.rawHashAt(target)) !== pending.afterHash) throw new Error('Pending CREATE target conflict');
        if (!exists) await this.writeRaw(pending.path, pending.afterRaw);
      } else {
        if (!exists) throw new Error('Pending UPDATE target disappeared');
        const currentHash = await this.rawHashAt(target);
        if (currentHash !== pending.afterHash) {
          if (pending.beforeHash === null || currentHash !== pending.beforeHash) throw new Error('Pending UPDATE target changed');
          await this.writeRaw(pending.path, pending.afterRaw);
        }
      }
      const revisions = await readJsonl(this.paths.revisions, RevisionSchema); if (revisions.errors.length) throw new Error(`Malformed revisions.jsonl: ${revisions.errors.map((error) => error.line).join(',')}`);
      if (!revisions.records.some((revision) => revision.revisionId === pending.revision.revisionId)) { await assertWorkspacePath(this.paths, this.paths.revisions); await appendJsonl(this.paths.revisions, pending.revision); }
      await this.rebuildProjections(); delete state.pendingMutation; await assertWorkspacePath(this.paths, this.paths.state); await writeJsonAtomic(this.paths.state, state); return;
    }
    const sourcePath = pathForMemory(this.paths, pending.path); const targetPath = pathForMemory(this.paths, pending.targetPath); const writePath = pending.action === 'MERGE' ? pending.writePath : pending.targetPath;
    await assertWorkspacePath(this.paths, sourcePath); await assertWorkspacePath(this.paths, targetPath); await assertWorkspacePath(this.paths, pathForMemory(this.paths, writePath));
    const archiveExistsBefore = await this.fileExists(pending.targetPath);
    if (archiveExistsBefore && (await this.rawHashAt(targetPath)) !== pending.archiveHash) throw new Error('Pending mutation archive target changed');
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
    if (revisions.errors.length) throw new Error(`Malformed revisions.jsonl: ${revisions.errors.map((error) => error.line).join(',')}`);
    if (!revisions.records.some((revision) => revision.revisionId === pending.revision.revisionId)) { await assertWorkspacePath(this.paths, this.paths.revisions); await appendJsonl(this.paths.revisions, pending.revision); }
    await this.rebuildProjections();
    delete state.pendingMutation; await assertWorkspacePath(this.paths, this.paths.state); await writeJsonAtomic(this.paths.state, state);
  }
  private async writeRaw(path: string, raw: string): Promise<void> { const target = pathForMemory(this.paths, path); await assertWorkspacePath(this.paths, target); await mkdir(dirname(target), { recursive: true }); const temporary = `${target}.${randomUUID()}.tmp`; try { await writeFile(temporary, raw, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; } }
  private async fileExists(path: string): Promise<boolean> { const target = pathForMemory(this.paths, path); await assertWorkspacePath(this.paths, target); try { await readFile(target); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
  private async rawHashAt(path: string): Promise<string> { const target = isAbsolute(path) ? path : pathForMemory(this.paths, path); await assertWorkspacePath(this.paths, target); return hash(await readFile(target)); }
  private async rebuildProjections(): Promise<void> { await assertOperationalPaths(this.paths); const documents = await this.reader.list(); await this.writeProjection(this.paths.index, renderIndex(documents)); await this.writeProjection(this.paths.profile, renderProfile(documents)); }
  private archiveRaw(document: Awaited<ReturnType<MemoryReader['read']>>, additionalSources: readonly string[] = []): string { return renderMemoryDocument(MemoryMetadataSchema.parse({ ...document.metadata, category: 'archive', sources: [...new Set([...document.metadata.sources, ...additionalSources])] }), document.content); }
  private async writeProjection(path: string, value: string): Promise<void> { await assertWorkspacePath(this.paths, path); await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; try { await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; } }
}

export interface ExplicitMemoryInput { path?: string; summary: string; content: string; sourceEvidence?: string[]; importance?: 'low' | 'normal' | 'high'; frequency?: 'low' | 'normal' | 'high'; expectedHash?: string; }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function slugify(value: string): string { return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'explicit-memory'; }
