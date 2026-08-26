import {
  redactSecrets,
  type AgentAction,
  type AgentTrigger,
  type TraceRecord,
} from '@personal-growth/shared';
import { assertActionAllowed } from './action-policy.js';
import { ContextBuilder, type AgentContext, type ContextBuildInput } from './context-builder.js';

export interface ContextSource {
  getContext?: (trigger: AgentTrigger) => ContextBuildInput | Promise<ContextBuildInput>;
  getSoul?: (trigger: AgentTrigger) => string | Promise<string>;
  getMission?: (trigger: AgentTrigger) => string | Promise<string>;
  getProfile?: (trigger: AgentTrigger) => string | undefined | Promise<string | undefined>;
  getRelevantMemories?: (trigger: AgentTrigger) => readonly string[] | Promise<readonly string[]>;
  getSessionDelta?: (trigger: AgentTrigger) => string | undefined | Promise<string | undefined>;
  getCurrentGoal?: (trigger: AgentTrigger) => string | undefined | Promise<string | undefined>;
}

export interface StructuredModelPort {
  generateAction(context: AgentContext, trigger: AgentTrigger): unknown | Promise<unknown>;
}

export interface TraceSink {
  write(record: TraceRecord): void | Promise<void>;
}

export interface ResponseDeliveryPort {
  deliver(text: string, trigger: AgentTrigger): void | Promise<void>;
}

export interface UserMessageDeliveryPort {
  deliver(message: { text: string; importance: 'low' | 'normal' | 'high' }, trigger: AgentTrigger): void | Promise<void>;
}

export interface SkillDraftWriter {
  write(skill: { name: string; instructions: string }, trigger: AgentTrigger): void | Promise<void>;
}

export interface PluginProposalWriter {
  write(proposal: { name: string; capabilityGap: string; design: string }, trigger: AgentTrigger): void | Promise<void>;
}

export interface ReflectionSink {
  write(reflection: { summary: string }, trigger: AgentTrigger): void | Promise<void>;
}

export interface AgentCoreOptions {
  contextSource: ContextSource;
  model: StructuredModelPort;
  contextBuilder?: ContextBuilder;
  trace?: TraceSink;
  response?: ResponseDeliveryPort;
  userMessage?: UserMessageDeliveryPort;
  skillWriter?: SkillDraftWriter;
  pluginWriter?: PluginProposalWriter;
  reflection?: ReflectionSink;
}

const defaultTrace: TraceSink = { write: () => undefined };

export class AgentCore {
  private readonly options: AgentCoreOptions;
  private readonly contextBuilder: ContextBuilder;

  constructor(options: AgentCoreOptions) {
    this.options = options;
    this.contextBuilder = options.contextBuilder ?? new ContextBuilder({ byteBudget: 16_384 });
  }

  async handle(trigger: AgentTrigger): Promise<AgentAction> {
    const sourceInput = await this.readContext(trigger);
    const context = this.contextBuilder.build({ ...sourceInput, trigger });
    const generated = await this.options.model.generateAction(context, trigger);
    let action: AgentAction;
    try {
      // The shared action schema is parsed inside the policy boundary, so malformed
      // model output can never reach an effect port.
      action = assertActionAllowed(trigger, generated);
    } catch (error) {
      await this.trace(trigger, 'action.rejected', { action: generated, reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    await this.trace(trigger, 'action.accepted', { action });
    await this.execute(action, trigger);
    return action;
  }

  private async readContext(trigger: AgentTrigger): Promise<ContextBuildInput> {
    const source = this.options.contextSource;
    if (source.getContext) return source.getContext(trigger);
    if (!source.getSoul || !source.getMission) {
      throw new Error('Context source must provide getContext or getSoul/getMission');
    }
    const [soul, mission, profile, memories, sessionDelta, currentGoal] = await Promise.all([
      source.getSoul(trigger),
      source.getMission(trigger),
      source.getProfile?.(trigger),
      source.getRelevantMemories?.(trigger),
      source.getSessionDelta?.(trigger),
      source.getCurrentGoal?.(trigger),
    ]);
    return { soul, mission, profile, memories, sessionDelta, currentGoal, trigger };
  }

  private async execute(action: AgentAction, trigger: AgentTrigger): Promise<void> {
    switch (action.type) {
      case 'NOOP':
        return;
      case 'RESPOND':
        if (!this.options.response) throw new Error('Response delivery port is not configured');
        await this.options.response.deliver(action.text, trigger);
        return;
      case 'MESSAGE_USER':
        if (!this.options.userMessage) throw new Error('User-message delivery port is not configured');
        await this.options.userMessage.deliver({ text: action.text, importance: action.importance }, trigger);
        return;
      case 'CREATE_SKILL':
        if (!this.options.skillWriter) throw new Error('Skill draft writer is not configured');
        await this.options.skillWriter.write({ name: action.name, instructions: action.instructions }, trigger);
        return;
      case 'PROPOSE_PLUGIN':
        if (!this.options.pluginWriter) throw new Error('Plugin proposal writer is not configured');
        await this.options.pluginWriter.write({ name: action.name, capabilityGap: action.capabilityGap, design: action.design }, trigger);
        return;
      case 'REFLECT':
        if (!this.options.reflection) throw new Error('Reflection sink is not configured');
        await this.options.reflection.write({ summary: action.summary }, trigger);
        return;
    }
  }

  private async trace(trigger: AgentTrigger, event: string, data: unknown): Promise<void> {
    await (this.options.trace ?? defaultTrace).write(redactSecrets({ at: trigger.at, event, data }));
  }
}
