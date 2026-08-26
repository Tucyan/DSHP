import { Service, type Context } from '@deepseek-ai/cordis';
import { AgentCore } from './service.js';

/** Cordis adapter only; domain code depends on no DSH or Cordis symbols. */
export class PersonalAgentCoreService extends Service<AgentCore> {
  readonly core: AgentCore;

  constructor(ctx: Context, core: AgentCore) {
    super(ctx, 'personalAgentCore');
    this.core = core;
  }

  handle = (trigger: Parameters<AgentCore['handle']>[0]) => this.core.handle(trigger);
}

export function createPersonalAgentCorePlugin(core: AgentCore) {
  const plugin = (ctx: Context) => {
    new PersonalAgentCoreService(ctx, core);
  };
  return plugin;
}

export interface PersonalAgentCorePluginOptions {
  core: AgentCore;
}

export function apply(ctx: Context, options: PersonalAgentCorePluginOptions): void {
  new PersonalAgentCoreService(ctx, options.core);
}
