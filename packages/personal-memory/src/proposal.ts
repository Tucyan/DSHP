import { z } from 'zod';
import { assertMemoryPath } from './paths.js';

const PathSchema = z.string().superRefine((value, ctx) => { try { assertMemoryPath(value); } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'Invalid memory path' }); } });
const EvidenceSchema = z.array(z.string().min(1)).min(1);
const common = { sourceEvidence: EvidenceSchema, summary: z.string().min(1), content: z.string().min(1), importance: z.enum(['low', 'normal', 'high']).optional(), frequency: z.enum(['low', 'normal', 'high']).optional() };
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const ProposalUnion = z.discriminatedUnion('action', [
  z.object({ action: z.literal('CREATE'), path: PathSchema, ...common, expectedHash: HashSchema.optional() }).strict(),
  z.object({ action: z.literal('UPDATE'), path: PathSchema, ...common, expectedHash: HashSchema }).strict(),
  z.object({ action: z.literal('MERGE'), path: PathSchema, targetPath: PathSchema, ...common, expectedHash: HashSchema }).strict(),
  z.object({ action: z.literal('ARCHIVE'), path: PathSchema, sourceEvidence: EvidenceSchema, expectedHash: HashSchema, reason: z.string().min(1).optional() }).strict(),
  z.object({ action: z.literal('IGNORE'), reason: z.string().min(1), sourceEvidence: EvidenceSchema, path: PathSchema.optional(), trace: z.string().min(1).optional() }).strict(),
]);
export const ProposalSchema = ProposalUnion;
export type MemoryProposal = z.infer<typeof ProposalUnion>;
export type ProposalAction = MemoryProposal['action'];

export function parseProposal(input: unknown): MemoryProposal { return ProposalSchema.parse(input); }
export function assertProposal(input: unknown): MemoryProposal { return parseProposal(input); }
