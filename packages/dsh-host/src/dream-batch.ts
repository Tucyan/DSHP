import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { ProposalSchema, type MemoryProposal } from '@personal-growth/personal-memory'
import { durableJsonRead, durableJsonTransaction } from '@personal-growth/shared'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const BatchSchema = z.object({ version: z.literal(1), historyId: z.string().min(1).max(512), batchId: z.string().regex(/^[a-f0-9]{64}$/), proposals: z.array(ProposalSchema).max(8), applied: z.array(z.number().int().min(0).max(7)).max(8) }).strict()
const StoreSchema = z.object({ batch: BatchSchema.nullable() }).strict()
const initial = { batch: null }

const common = { summary: '稳定偏好摘要', content: '有来源支持的完整事实', sourceEvidence: ['conversation:user'], importance: 'normal', frequency: 'high' }
export const DREAM_PROPOSAL_CONTRACT = `最多输出 8 项提案。每个独立稳定事实单独一项，同一路径只能变更一次；忽略临时和重复信息。不执行工具。仅输出 JSON 数组，不得额外字段。sourceEvidence 不得含 history:、proposal: 或 batch: 前缀。UPDATE/MERGE/ARCHIVE 的 expectedHash 必须使用上下文提供的真实 HASH，示例中的占位 hash 不可照抄。只在高频信息时使用 frequency=high。格式示例：\n${JSON.stringify([
  { action: 'CREATE', path: 'preferences/example.md', ...common },
  { action: 'UPDATE', path: 'preferences/existing.md', ...common, expectedHash: '0'.repeat(64) },
  { action: 'MERGE', path: 'preferences/source.md', targetPath: 'preferences/target.md', ...common, expectedHash: '0'.repeat(64) },
  { action: 'ARCHIVE', path: 'preferences/old.md', sourceEvidence: ['conversation:user'], expectedHash: '0'.repeat(64), reason: '已失效' },
  { action: 'IGNORE', reason: '无可靠变化', sourceEvidence: ['conversation:user'] },
])}`

function normalize(raw: unknown): MemoryProposal[] {
  const proposals = z.array(ProposalSchema).max(8).parse(raw)
  if (Buffer.byteLength(JSON.stringify(proposals)) > 64000) throw new Error('Dream batch exceeds byte limit')
  const seen = new Set<string>(), paths = new Set<string>(), result: MemoryProposal[] = []
  for (const proposal of proposals) {
    if (proposal.sourceEvidence.some(value => /^(history|proposal|batch):/.test(value))) throw new Error('Dream proposal contains reserved evidence')
    const key = hash(proposal)
    if (seen.has(key)) continue
    seen.add(key)
    if (proposal.action !== 'IGNORE') {
      const affected = proposal.action === 'MERGE' ? [proposal.path, proposal.targetPath] : [proposal.path]
      for (const path of affected) {
        const normalized = path.toLowerCase()
        if (paths.has(normalized)) throw new Error('Dream batch paths overlap')
        paths.add(normalized)
      }
    }
    result.push(proposal)
  }
  return result
}

/** Caller owns the history lease. Frozen proposals survive history lease expiry/failure. */
export class DreamBatchStore {
  constructor(private readonly workspace: string) {}
  async run(historyId: string, propose: () => Promise<unknown>, apply: (proposal: MemoryProposal) => Promise<unknown>): Promise<number> {
    z.string().min(1).max(512).parse(historyId)
    const path = join(this.workspace, '.personal-growth', 'dream-batches', `${hash(historyId)}.json`)
    let state = await durableJsonRead(path, this.workspace, StoreSchema, initial)
    if (!state.batch) {
      const proposals = normalize(await propose())
      const batch = { version: 1 as const, historyId, batchId: hash(proposals), proposals, applied: [] }
      state = (await durableJsonTransaction(path, this.workspace, StoreSchema, initial, current => { current.batch ??= batch })).state
    }
    const batch = state.batch!
    if (batch.historyId !== historyId || hash(normalize(batch.proposals)) !== batch.batchId || new Set(batch.applied).size !== batch.applied.length || batch.applied.some(index => index >= batch.proposals.length)) throw new Error('Malformed Dream batch journal')
    for (const [index, proposal] of batch.proposals.entries()) {
      if (batch.applied.includes(index)) continue
      const identity = hash(proposal)
      await apply(ProposalSchema.parse({ ...proposal, sourceEvidence: [...proposal.sourceEvidence, `history:${historyId}`, `batch:${batch.batchId}`, `proposal:${identity}`] }))
      await durableJsonTransaction(path, this.workspace, StoreSchema, initial, current => {
        if (!current.batch || current.batch.batchId !== batch.batchId) throw new Error('Dream batch ownership changed')
        if (!current.batch.applied.includes(index)) current.batch.applied.push(index)
      })
    }
    return batch.proposals.filter(proposal => proposal.action !== 'IGNORE').length
  }
}
