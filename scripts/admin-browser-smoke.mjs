import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import console from 'node:console'
import { startAdminServer } from '../packages/dsh-host/dist/admin/server.js'
import { AdminBackend, HostStatus } from '../packages/dsh-host/dist/admin/backend.js'
import { SafeAdminFiles } from '../packages/dsh-host/dist/admin/files.js'
import { PromptStore } from '../packages/dsh-host/dist/admin/prompts.js'
import { HeartbeatController } from '../packages/dsh-host/dist/admin/heartbeat.js'
import { MemoryService } from '../packages/personal-memory/dist/service.js'

// Disposable UI acceptance fixture. Never opens QQ or the production workspace.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(join(project, 'runtime/admin'), { recursive: true })
const root = await mkdtemp(join(project, 'runtime/admin/browser-'))
await mkdir(join(root, 'workspace')); await mkdir(join(root, 'runtime/credentials'), { recursive: true })
await writeFile(join(root, 'workspace/SOUL.md'), '# UI 验收测试 Agent\n仅用于本地管理台验收。')
await writeFile(join(root, 'workspace/AGENT.md'), '# 测试 Mission\n不连接 QQ，不调用模型，不修改生产工作区。')
await writeFile(join(root, 'runtime/credentials/admin-token.json'), JSON.stringify({ version: 1, token: Buffer.alloc(32, 9).toString('base64url'), rotatedAt: new Date().toISOString() }))
await cp(join(project, 'packages/admin-web/dist'), join(root, 'assets'), { recursive: true })
const files = new SafeAdminFiles(root)
const prompts = new PromptStore(files); await prompts.initialize()
const memory = new MemoryService({ workspaceRoot: join(root, 'workspace') })
await memory.apply({ action: 'CREATE', path: 'preferences/acceptance.md', summary: '测试记忆：学习时段', content: '这是隔离 UI 验收数据，不是用户的真实记忆。', sourceEvidence: ['test:browser'], frequency: 'high' })
const status = new HostStatus('ui-test-foreground'); status.lifecycle = '测试实例'; status.qq = 'stopped'; status.model = { provider: 'test adapter', model: '未调用模型' }
const heartbeat = new HeartbeatController(files, { timeZone: 'Asia/Singapore', quietHours: { start: '23:00', end: '07:00' }, cooldownMinutes: 120, maxContactsPerDay: 4 })
await heartbeat.initialize(); await heartbeat.update({ ...heartbeat.view().settings, foregroundPaused: true, backgroundPaused: true }, heartbeat.view().revision)
heartbeat.start(async (_role, id) => ({ occurrenceId: id, status: 'completed', action: { type: 'NOOP', reason: 'isolated UI acceptance' } }))
const events = [{ seq: 1, type: 'user/message', time: Date.now(), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '这是一条隔离测试消息。' }] } }, { seq: 2, type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: '管理台显示只读内容，切换会话不会向 QQ 发送消息。' }] } } }]
const backend = new AdminBackend({ files, memory, prompts, heartbeat, status, sessionIds: ['ui-test-foreground', 'ui-test-foreground-hidden-dream'], sessions: { async list() { return [{ id: 'ui-test-foreground' }, { id: 'ui-test-foreground-hidden-dream' }] }, async read(id, from) { return { id, events: events.filter(event => event.seq >= from) } } }, schedule: async operation => { if (operation !== 'list') throw new Error('fixture has no schedule runtime'); return [] }, pending: async () => ({ memory: 0, outbound: 0 }), internalPrompts: { decision: '测试环境：仅返回 NOOP。' } })
const server = await startAdminServer({ repoRoot: root, runtimeRoot: join(root, 'runtime'), assetsRoot: join(root, 'assets'), port: Number(process.env.PGA_SMOKE_PORT ?? 3182), backend })
console.info(`Isolated UI test: ${server.url}\nFixture: ${root}`)
const close = async () => { await server.close(); await heartbeat.close() }
process.once('SIGINT', () => { void close() }); process.once('SIGTERM', () => { void close() })
