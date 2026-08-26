import { z } from 'zod';

const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'appSecretEnv must be an environment variable name');
export const QqConfigSchema = z.object({
  peerId: z.string().min(1), appId: z.string().min(1), appSecretEnv: EnvName,
  bindingPath: z.string().min(1).optional(),
}).strict();
export type QqConfig = z.infer<typeof QqConfigSchema>;
export function parseQqConfig(input: unknown): QqConfig { return QqConfigSchema.parse(input); }
export function publicQqConfig(config: QqConfig): Omit<QqConfig, 'appSecretEnv'> & { appSecretConfigured: boolean } {
  return { peerId: config.peerId, appId: config.appId, appSecretConfigured: Boolean(process.env[config.appSecretEnv]) };
}

