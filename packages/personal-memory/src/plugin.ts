import { Service, type Context } from '@deepseek-ai/cordis';
import { MemoryService, type MemoryServiceOptions } from './service.js';

export class PersonalMemoryService extends Service<MemoryService> {
  private instance?: MemoryService;
  private readonly options?: MemoryServiceOptions;
  constructor(ctx: Context, memory?: MemoryService, options?: MemoryServiceOptions) {
    super(ctx, 'personalMemory');
    this.instance = memory;
    this.options = options;
  }
  get memory(): MemoryService { return this.instance ??= new MemoryService(this.options); }
  list = (category?: Parameters<MemoryService['list']>[0]) => this.memory.list(category);
  read = (path: string) => this.memory.read(path);
  search = (query: string, limit?: number) => this.memory.search(query, limit);
  apply = (proposal: Parameters<MemoryService['apply']>[0]) => this.memory.apply(proposal);
  rememberExplicit = (input: Parameters<MemoryService['rememberExplicit']>[0]) => this.memory.rememberExplicit(input);
}

export interface PersonalMemoryPluginOptions extends MemoryServiceOptions { memory?: MemoryService; }
export function createPersonalMemoryPlugin(memory?: MemoryService) { return (ctx: Context) => { new PersonalMemoryService(ctx, memory); }; }
export function apply(ctx: Context, options?: PersonalMemoryPluginOptions): void { new PersonalMemoryService(ctx, options?.memory, options); }
