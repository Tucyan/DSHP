import { z } from 'zod';
import { SafeMemoryPathSchema } from './paths.js';

export const RevisionSchema = z.object({
  revisionId: z.string().min(1), time: z.string().min(1), actor: z.string().min(1),
  action: z.enum(['CREATE', 'UPDATE', 'MERGE', 'ARCHIVE']), path: SafeMemoryPathSchema,
  source: z.array(z.string().min(1)).min(1), beforeHash: z.union([z.string().regex(/^[a-f0-9]{64}$/i), z.null()]), afterHash: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict().superRefine((revision, ctx) => {
  const archive = revision.path.toLowerCase().startsWith('archive/');
  if (archive) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Revision path must name an active source document' });
  if (revision.action === 'CREATE' && revision.beforeHash !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CREATE revision requires null beforeHash' });
  if (revision.action !== 'CREATE' && revision.beforeHash === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mutating revision requires beforeHash' });
});
export type RevisionRecord = z.infer<typeof RevisionSchema>;
