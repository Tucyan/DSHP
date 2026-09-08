import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PromptStore } from '../src/admin/prompts.js'
import { SafeAdminFiles } from '../src/admin/files.js'
import { HeartbeatController } from '../src/admin/heartbeat.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pga-admin-')); roots.push(root)
  await mkdir(join(root, 'workspace')); await writeFile(join(root, 'workspace/SOUL.md'), 'original soul')
  await writeFile(join(root, 'workspace/AGENT.md'), 'original mission')
  return { root, files: new SafeAdminFiles(root) }
}
describe('managed prompt versions', () => {
  it('imports files and holds current turn stable until the next beginTurn', async () => {
    const { root, files } = await fixture(); const prompts = new PromptStore(files)
    await prompts.initialize(); prompts.beginTurn('foreground')
    const before = prompts.view()
    await prompts.update({ key: 'soul', text: 'new soul', expectedHash: before.soul.hash })
    expect(prompts.textFor('foreground')).toContain('original soul')
    expect(prompts.view().active.foreground.soulHash).toBe(before.soul.hash)
    prompts.beginTurn('foreground'); expect(prompts.textFor('foreground')).toContain('new soul')
    expect(await readFile(join(root, 'workspace/SOUL.md'), 'utf8')).toBe('new soul')
    const reopened = new PromptStore(files); await reopened.initialize()
    expect(reopened.view().soul.text).toBe('new soul')
    expect(reopened.view().history.length).toBe(1)
  })
  it('rejects stale writes and non-editable prompt keys without changing data', async () => {
    const { files } = await fixture(); const prompts = new PromptStore(files); await prompts.initialize()
    await expect(prompts.update({ key: 'soul', text: 'bad', expectedHash: '0'.repeat(64) })).rejects.toMatchObject({ statusCode: 409 })
    await expect(prompts.update({ key: 'decision', text: 'bad', expectedHash: '0'.repeat(64) })).rejects.toThrow()
    expect(prompts.view().soul.text).toBe('original soul')
  })
  it('does not overwrite an unrelated prompt file during a single-key save', async () => {
    const { root, files } = await fixture(); const prompts = new PromptStore(files); await prompts.initialize()
    await writeFile(join(root, 'workspace/AGENT.md'), 'external mission edit')
    await prompts.update({ key: 'soul', text: 'updated soul', expectedHash: prompts.view().soul.hash })
    expect(await readFile(join(root, 'workspace/AGENT.md'), 'utf8')).toBe('external mission edit')
  })
})
describe('admin path safety', () => {
  it('rejects traversal, Windows aliases and junction escapes before read or write', async () => {
    const { root, files } = await fixture()
    for (const path of ['../outside', '/outside', 'runtime/CON/x', 'runtime/file:ads', 'runtime/file.']) await expect(files.read(path)).rejects.toThrow()
    const outside = await mkdtemp(join(tmpdir(), 'pga-outside-')); roots.push(outside)
    await symlink(outside, join(root, 'escape'), 'junction')
    await expect(files.read('escape/secret')).rejects.toThrow()
    await expect(files.write('escape/secret', 'bad')).rejects.toThrow()
  })
})
describe('heartbeat management', () => {
  it('retains safe action failure codes without exposing provider details', async () => {
    const { files } = await fixture()
    const { HiddenActionError } = await import('../src/hidden-action.js')
    const control = new HeartbeatController(files, { timeZone: 'Asia/Singapore', quietHours: { start: '23:00', end: '07:00' }, cooldownMinutes: 120, maxContactsPerDay: 4 })
    await control.initialize()
    control.start(async () => { throw new HiddenActionError('heartbeat_invalid_action') })
    control.run('background', 'invalid-format')
    await control.drain()
    await control.close()
    expect(control.jobs()[0]).toMatchObject({ status: 'failed', error: 'heartbeat_invalid_action' })
  })
  it('persists settings and deduplicates manual jobs while returning real outcomes', async () => {
    const { files } = await fixture(); let calls = 0
    const control = new HeartbeatController(files, { timeZone: 'Asia/Singapore', quietHours: { start: '23:00', end: '07:00' }, cooldownMinutes: 120, maxContactsPerDay: 4 })
    await control.initialize(); control.start(async () => { calls++; return { status: 'denied', action: { type: 'NOOP' } } })
    const a = control.run('foreground', 'same-request'); const b = control.run('foreground', 'same-request')
    expect(a.id).toBe(b.id); await control.drain(); expect(calls).toBe(1)
    expect(control.jobs()[0].result).toMatchObject({ status: 'denied' })
    const settings = control.view().settings
    await control.update({ ...settings, foregroundPaused: true }, control.view().revision)
    await control.close()
    const reopened = new HeartbeatController(files, settings.policy); await reopened.initialize()
    expect(reopened.view().settings.foregroundPaused).toBe(true)
    expect(() => reopened.run('foreground', 'new')).toThrow()
  })
})
