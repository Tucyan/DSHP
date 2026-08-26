import { z } from 'zod';
import { assertMemoryPath } from './paths.js';

const PathSchema = z.string().superRefine((value, ctx) => { try { assertMemoryPath(value); } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'Invalid memory path' }); } });
const EvidenceSchema = z.array(z.string().min(1)).min(1);
const common = { sourceEvidence: EvidenceSchema, summary: z.string().min(1), content: z.string().min(1), importance: z.enum(['low', 'normal', 'high']).optional(), frequency: z.enum(['low', 'normal', 'high']).optional() };
const ProposalUnion = z.discriminatedUnion('action', [
  z.object({ action: z.literal('CREATE'), path: PathSchema, ...common, expectedHash: z.string().length(64).optional() }).strict(),
  z.object({ action: z.literal('UPDATE'), path: PathSchema, ...common, expectedHash: z.string().length(64) }).strict(),
  z.object({ action: z.literal('MERGE'), path: PathSchema, targetPath: PathSchema, ...common, expectedHash: z.string().length(64) }).strict(),
  z.object({ action: z.literal('ARCHIVE'), path: PathSchema, sourceEvidence: EvidenceSchema, summary: z.string().min(1), content: z.string().min(1), expectedHash: z.string().length(64) }).strict(),
  z.object({ action: z.literal('IGNORE'), reason: z.string().min(1), sourceEvidence: EvidenceSchema, path: PathSchema.optional(), trace: z.string().min(1).optional() }).strict(),
]);

export const ProposalSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object') return input;
  const value = { ...(input as Record<string, unknown>) };
  if (!value.sourceEvidence && Array.isArray(value.source)) value.sourceEvidence = value.source;
  if (!value.sourceEvidence && Array.isArray(value.evidence)) value.sourceEvidence = value.evidence;
  if (!value.path && typeof value.fromPath === 'string') value.path = value.fromPath;
  if (!value.targetPath && typeof value.toPath === 'string') value.targetPath = value.toPath;
  if (Array.isArray(value.sourceEvidence)) value.sourceEvidence = value.sourceEvidence.map((item) => typeof item === 'string' ? item : JSON.stringify(item));
  delete value.source;
  delete value.evidence;
  delete value.fromPath;
  delete value.toPath;
  return value;
}, ProposalUnion);
export type MemoryProposal = z.infer<typeof ProposalUnion>;
export type ProposalAction = MemoryProposal['action'];

export function parseProposal(input: unknown): MemoryProposal { return ProposalSchema.parse(input); }
export function assertProposal(input: unknown): MemoryProposal { return parseProposal(input); }
