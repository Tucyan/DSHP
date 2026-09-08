import { AgentActionSchema, assertActionAllowedForTrigger, type AgentAction, type AgentTrigger } from '@personal-growth/shared'

export class HiddenActionError extends Error {
  constructor(readonly code: 'heartbeat_invalid_action' | 'heartbeat_model_failed') { super(code) }
}

export function parseAgentActionJson(raw: string): AgentAction {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Hidden agent returned empty action')
  const input: unknown = JSON.parse(raw)
  const parsed = AgentActionSchema.parse(input)
  if (!input || typeof input !== 'object' || Object.keys(input).length !== Object.keys(parsed).length || Object.keys(input).some(key => !Object.prototype.hasOwnProperty.call(parsed, key))) throw new Error('Hidden agent returned non-strict action JSON')
  return parsed
}

export async function requestHiddenAction(role: 'decision' | 'maintenance', trigger: AgentTrigger, context: string, generate: (prompt: string) => Promise<string>): Promise<AgentAction> {
  const examples: AgentAction[] = [{ type: 'NOOP', reason: '没有需要处理的事项' }]
  if (role === 'decision') examples.push({ type: 'MESSAGE_USER', text: '需要告知用户的内容', importance: 'normal' })
  else examples.push(
    { type: 'REFLECT', summary: '反思结论' },
    { type: 'CREATE_SKILL', name: 'specific-workflow', instructions: '具体工作流步骤' },
    { type: 'PROPOSE_PLUGIN', name: 'specific-plugin', capabilityGap: '能力缺口', design: '插件设计' },
  )
  const contract = `仅输出一个严格 JSON 对象，不得 Markdown 或额外字段。判别字段必须叫 type，不能叫 action。每个示例的字段都必填，字符串不能为空。选择与事实相符的一项并填写内容；不要执行工具，动作由 Host 校验后执行。允许格式：\n${examples.map(value => JSON.stringify(value)).join('\n')}`
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string
    try { raw = await generate(`${contract}\n${attempt ? '上次输出格式不符合约定。请重新输出完整的 JSON，不要解释。\n' : ''}${context}`) }
    catch { throw new HiddenActionError('heartbeat_model_failed') }
    try {
      const action = assertActionAllowedForTrigger(trigger, parseAgentActionJson(raw))
      if (!examples.some(example => example.type === action.type)) throw new Error('Action outside role')
      return action
    } catch { if (attempt === 1) throw new HiddenActionError('heartbeat_invalid_action') }
  }
  throw new HiddenActionError('heartbeat_invalid_action')
}
