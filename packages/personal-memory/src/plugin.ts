import { Service, type Context } from '@deepseek-ai/cordis';
import { MemoryService, type MemoryServiceOptions } from './service.js';

export class PersonalMemoryService extends Service<MemoryService> {
  readonly memory: MemoryService;
  constructor(ctx: Context, memory?: MemoryService) { super(ctx, 'personalMemory'); this.memory = memory ?? new MemoryService(); }
  list = (category?: Parameters<MemoryService['list']>[0]) => this.memory.list(category);
  read = (path: string) => this.memory.read(path);
  search = (query: string, limit?: number) => this.memory.search(query, limit);
  apply = (proposal: Parameters<MemoryService['apply']>[0]) => this.memory.apply(proposal);
  rememberExplicit = (input: Parameters<MemoryService['rememberExplicit']>[0]) => this.memory.rememberExplicit(input);
}

export interface PersonalMemoryPluginOptions extends MemoryServiceOptions { memory?: MemoryService; }
export function createPersonalMemoryPlugin(memory?: MemoryService) { return (ctx: Context) => { new PersonalMemoryService(ctx, memory); }; }
export function apply(ctx: Context, options?: PersonalMemoryPluginOptions): void { new PersonalMemoryService(ctx, options?.memory ?? new MemoryService(options)); }

