import { z } from 'zod';
import { SafeMemoryPathSchema } from './paths.js';

export const RevisionSchema = z.object({
  revisionId: z.string().min(1), time: z.string().min(1), actor: z.string().min(1),
  action: z.enum(['CREATE', 'UPDATE', 'MERGE', 'ARCHIVE']), path: SafeMemoryPathSchema,
  source: z.array(z.string().min(1)).min(1), beforeHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(), afterHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict();
export type RevisionRecord = z.infer<typeof RevisionSchema>;
