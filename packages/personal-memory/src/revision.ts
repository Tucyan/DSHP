import { z } from 'zod';

export const RevisionSchema = z.object({
  revisionId: z.string().min(1), time: z.string().min(1), actor: z.string().min(1),
  action: z.enum(['CREATE', 'UPDATE', 'MERGE', 'ARCHIVE']), path: z.string().min(1),
  source: z.array(z.string().min(1)).min(1), beforeHash: z.string().length(64).optional(), afterHash: z.string().length(64).optional(),
}).strict();
export type RevisionRecord = z.infer<typeof RevisionSchema>;

