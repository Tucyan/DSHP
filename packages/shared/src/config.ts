import { z } from 'zod';

/** Shared runtime configuration. Unknown package-specific settings are preserved. */
export const ConfigSchema = z.object({
  workspaceDir: z.string().min(1),
  timezone: z.string().min(1).default('UTC'),
}).passthrough();

export type AgentConfig = z.infer<typeof ConfigSchema>;
export type SharedConfig = AgentConfig;
export const AgentConfigSchema = ConfigSchema;
export const SharedConfigSchema = ConfigSchema;

export function parseConfig(input: unknown): AgentConfig {
  return ConfigSchema.parse(input);
}

export function safeParseConfig(input: unknown) {
  return ConfigSchema.safeParse(input);
}
