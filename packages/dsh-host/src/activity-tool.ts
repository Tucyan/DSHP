import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ActivityQuery, ActivitySnapshot } from './activity.js'

export interface ActivityToolRegistrar { register(definition: ToolDefinition): () => void }
export type ActivityToolReader = (query: ActivityQuery) => Promise<ActivitySnapshot>

export function registerActivityTool(registrar: ActivityToolRegistrar, read: ActivityToolReader, defaults: { date: () => string; timeZone: () => string; asOf: () => string }): () => void {
  return registrar.register(defineTool({
    name: 'get_activity',
    description: 'Read-only daily activity for the current user conversation.',
    parameters: {
      date: { type: 'string', description: 'Local date YYYY-MM-DD. Defaults to today.' },
      limit: { type: 'number', description: 'Number of recent messages, from 1 to 50.' },
      cursor: { type: 'string', description: 'Opaque pagination cursor returned by a previous call.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      const timeZone = defaults.timeZone()
      const query: ActivityQuery = {
        date: typeof args.date === 'string' ? args.date : defaults.date(),
        timeZone,
        asOf: defaults.asOf(),
        limit: typeof args.limit === 'number' ? args.limit : 20,
        ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
      }
      return await read(query) as any
    },
  }))
}
