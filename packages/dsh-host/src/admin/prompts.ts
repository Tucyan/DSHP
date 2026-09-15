import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AdminError, SafeAdminFiles } from './files.js'

const text = z.string().min(1).max(64 * 1024)
const document = z.object({ text, hash: z.string().length(64) }).strict()
const editableKey = z.enum(['soul', 'mission', 'foregroundHeartbeat', 'backgroundHeartbeat'])
const fileKey = z.enum(['soul', 'mission'])
const schema = z.object({ version: z.literal(2), soul: document, mission: document, foregroundHeartbeat: document, backgroundHeartbeat: document, pending: fileKey.optional(), history: z.array(z.object({ key: editableKey, at: z.string().datetime(), before: document, after: document }).strict()).max(100) }).strict()
type State = z.infer<typeof schema>
const defaultDocument = (value: string): z.infer<typeof document> => ({ text: value, hash: hash(value) })
export const DEFAULT_FOREGROUND_HEARTBEAT_PROMPT = '前台心跳唤醒主 Agent。检查当前目标、待办和上下文；有需要时使用工具推进工作；没有需要时保持静默结束；需要联系用户时必须调用 send_message。'
export const DEFAULT_BACKGROUND_HEARTBEAT_PROMPT = '你是后台维护器。仅输出严格 JSON AgentAction，只能选择 REFLECT、CREATE_SKILL、PROPOSE_PLUGIN 或 NOOP。长期记忆 proposal 已优先处理；如有能力缺口优先 CREATE_SKILL，其次 PROPOSE_PLUGIN，否则 REFLECT 或 NOOP。绝不联系用户。'
const storageSchema: z.ZodType<State, z.ZodTypeDef, unknown> = z.preprocess(value => {
  if (value && typeof value === 'object' && (value as { version?: unknown }).version === 1) return {
    ...(value as Record<string, unknown>),
    version: 2,
    foregroundHeartbeat: defaultDocument(DEFAULT_FOREGROUND_HEARTBEAT_PROMPT),
    backgroundHeartbeat: defaultDocument(DEFAULT_BACKGROUND_HEARTBEAT_PROMPT),
  }
  return value
}, schema)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const filename = 'runtime/admin/prompts.json'
const names = { soul: 'workspace/SOUL.md', mission: 'workspace/AGENT.md' }
type HeartbeatRole = 'foreground' | 'background'
export class PromptStore {
  private state?: State
  private active = new Map<string, Pick<State, 'soul' | 'mission'>>()
  private heartbeatActive = new Map<string, z.infer<typeof document>>()
  constructor(private readonly files: SafeAdminFiles) {}
  async initialize() {
    await this.exclusive(async () => {
    const soulText = await this.files.optional(names.soul) || 'Personal Growth Agent'
    const missionText = await this.files.optional(names.mission) || 'Help the fixed user grow through thoughtful, private assistance.'
    const initial: State = { version: 2, soul: { text: soulText, hash: hash(soulText) }, mission: { text: missionText, hash: hash(missionText) }, foregroundHeartbeat: defaultDocument(DEFAULT_FOREGROUND_HEARTBEAT_PROMPT), backgroundHeartbeat: defaultDocument(DEFAULT_BACKGROUND_HEARTBEAT_PROMPT), history: [] }
    this.state = (await this.files.change(filename, storageSchema, initial, state => state)).state as State
      await this.projectPending()
    })
  }
  private async exclusive<T>(operation: () => Promise<T>) {
    return (await this.files.change('runtime/admin/prompt-operation.json', z.object({ version: z.literal(1) }).strict(), { version: 1 }, operation)).result
  }
  private async projectPending() {
    const state = this.state!; const key = state.pending; if (!key) return
    const previous = state.history.at(-1)
    const currentFile = await this.files.optional(names[key])
    if (currentFile && hash(currentFile) !== state[key].hash && hash(currentFile) !== previous?.before.hash) throw new AdminError(409, 'prompt_recovery_conflict')
    await this.files.write(names[key], state[key].text)
    this.state = (await this.files.change(filename, schema, state, value => { delete value.pending })).state
  }
  view() {
    if (!this.state) throw new AdminError(503, 'prompts_not_ready')
    return { ...structuredClone(this.state), active: Object.fromEntries([...this.active].map(([id, snapshot]) => [id, { soulHash: snapshot.soul.hash, missionHash: snapshot.mission.hash }])) }
  }
  beginTurn(id: string) { if (this.state) this.active.set(id, { soul: { ...this.state.soul }, mission: { ...this.state.mission } }) }
  beginHeartbeat(id: string, role: HeartbeatRole) {
    if (this.state) this.heartbeatActive.set(`${role}:${id}`, { ...this.state[`${role}Heartbeat`] })
  }
  heartbeatText(id: string, role: HeartbeatRole) {
    const snapshot = this.heartbeatActive.get(`${role}:${id}`) ?? this.state?.[`${role}Heartbeat`]
    return snapshot?.text ?? ''
  }
  textFor(id: string) {
    const snapshot = this.active.get(id) ?? this.state
    return snapshot ? `SOUL\n${snapshot.soul.text}\n\nMISSION\n${snapshot.mission.text}` : ''
  }
  async update(input: unknown) {
    const parsed = z.object({ key: editableKey, text, expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input)
    return this.exclusive(async () => {
    const initial = this.state; if (!initial) throw new AdminError(503, 'prompts_not_ready')
    this.state = await this.files.json(filename, storageSchema, initial) as State; await this.projectPending()
    const result = await this.files.change(filename, schema, initial, async state => {
      if (state[parsed.key].hash !== parsed.expectedHash) throw new AdminError(409, 'prompt_conflict')
      const currentFile = parsed.key === 'soul' || parsed.key === 'mission' ? await this.files.optional(names[parsed.key]) : ''
      if (currentFile && hash(currentFile) !== parsed.expectedHash) throw new AdminError(409, 'prompt_file_conflict')
      const next = { text: parsed.text, hash: hash(parsed.text) }
      state.history.push({ key: parsed.key, at: new Date().toISOString(), before: state[parsed.key], after: next })
      state.history = state.history.slice(-100); state[parsed.key] = next
      if (parsed.key === 'soul' || parsed.key === 'mission') state.pending = parsed.key
    })
    this.state = result.state; await this.projectPending(); return this.view()
    })
  }
}
