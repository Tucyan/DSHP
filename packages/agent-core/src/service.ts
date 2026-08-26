import {
  AgentActionSchema,
  AgentTriggerSchema,
  redactSecrets,
  type AgentAction,
  type AgentTrigger,
  type TraceRecord,
} from '@personal-growth/shared';
import { assertActionAllowed, PolicyViolation } from './action-policy.js';
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
    const parsedTrigger = AgentTriggerSchema.safeParse(trigger);
    if (!parsedTrigger.success) {
      await this.safeTrace('unknown', 'action.rejected', {
        rawType: rawType(trigger),
        reasonCode: 'invalid_trigger',
        issueCount: parsedTrigger.error.issues.length,
      });
      throw new PolicyViolation('Invalid agent trigger', trigger, undefined);
    }
    const sourceInput = await this.readContext(parsedTrigger.data);
    const context = this.contextBuilder.build({ ...sourceInput, trigger: parsedTrigger.data });
    const generated = await this.options.model.generateAction(context, parsedTrigger.data);
    let action: AgentAction;
    const parsedAction = AgentActionSchema.safeParse(generated);
    if (!parsedAction.success) {
      const error = new PolicyViolation('Invalid agent action', parsedTrigger.data, undefined);
      await this.safeTrace(parsedTrigger.data.at, 'action.rejected', {
        rawType: rawType(generated),
        reasonCode: 'invalid_action',
        issueCount: parsedAction.error.issues.length,
      });
      throw error;
    }
    try {
      action = assertActionAllowed(parsedTrigger.data, parsedAction.data);
    } catch (error) {
      await this.safeTrace(parsedTrigger.data.at, 'action.rejected', {
        rawType: rawType(generated),
        reasonCode: 'policy_violation',
      });
      throw error;
    }

    await this.trace(parsedTrigger.data, 'action.accepted', { action });
    await this.execute(action, parsedTrigger.data);
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

  private async safeTrace(at: string, event: string, data: unknown): Promise<void> {
    try {
      await (this.options.trace ?? defaultTrace).write({ at, event, data });
    } catch {
      // Rejection handling must not be made unsafe by an untrusted trace sink.
    }
  }
}

function rawType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
