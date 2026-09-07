import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { durableJsonRead, durableJsonTransaction } from '@personal-growth/shared'

export class AdminError extends Error {
  constructor(readonly statusCode: number, readonly code: string) { super(code) }
}
export class SafeAdminFiles {
  readonly root: string
  constructor(root: string) { this.root = resolve(root) }
  async path(name: string): Promise<string> {
    if (!name || isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..' || /:|[. ]$/u.test(part) || [...part].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new AdminError(400, 'unsafe_path')
    const target = resolve(this.root, name)
    for (const home of [process.env.USERPROFILE, process.env.HOME].filter(Boolean) as string[]) {
      for (const folder of ['.dsh', '.agents']) {
        const rel = relative(resolve(home, folder), this.root)
        if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new AdminError(400, 'unsafe_root')
      }
    }
    let cursor = target
    while (true) {
      try {
        const stat = await lstat(cursor)
        if (stat.isSymbolicLink() || resolve(await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new AdminError(400, 'unsafe_path')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent
    }
    return target
  }
  async read(name: string, maxBytes = 256 * 1024): Promise<string> {
    const path = await this.path(name)
    const handle = await open(path, 'r')
    try {
      if ((await handle.stat()).size > maxBytes) throw new AdminError(413, 'file_too_large')
      return await handle.readFile('utf8')
    } finally { await handle.close() }
  }
  async optional(name: string, maxBytes?: number): Promise<string> {
    try { return await this.read(name, maxBytes) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
  }
  async write(name: string, text: string): Promise<void> {
    const path = await this.path(name); await mkdir(dirname(path), { recursive: true }); await this.path(name)
    const temporary = `${path}.${randomUUID()}.tmp`
    try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await this.path(name); await rename(temporary, path) }
    finally { await unlink(temporary).catch(() => undefined) }
  }
  async json<T>(name: string, schema: z.ZodType<T>, initial: T): Promise<T> {
    return durableJsonRead(await this.path(name), this.root, schema, initial)
  }
  async change<T, R>(name: string, schema: z.ZodType<T>, initial: T, operation: (state: T) => Promise<R> | R) {
    return durableJsonTransaction(await this.path(name), this.root, schema, initial, async state => { await this.path(name); return operation(state) })
  }
  async list(name: string, depth = 3): Promise<string[]> {
    const result: string[] = []
    const visit = async (prefix: string, remaining: number) => {
      let entries
      try { entries = await readdir(await this.path(prefix), { withFileTypes: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      for (const entry of entries) {
        if (result.length >= 500) break
        const child = `${prefix}/${entry.name}`; await this.path(child)
        if (entry.isDirectory() && remaining > 0) await visit(child, remaining - 1)
        else if (entry.isFile() && entry.name.endsWith('.md')) result.push(child)
      }
    }
    await visit(name, depth); return result.sort()
  }
  async tail(name: string, limit = 200): Promise<unknown[]> {
    const path = await this.path(name)
    let handle
    try { handle = await open(path, 'r') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    try {
      const size = (await handle.stat()).size; const start = Math.max(0, size - 1024 * 1024)
      const bytes = Buffer.alloc(size - start); await handle.read(bytes, 0, bytes.length, start)
      const text = bytes.toString('utf8'); const lines = text.split('\n'); if (start) lines.shift(); if (!text.endsWith('\n')) lines.pop()
      return lines.filter(line => line.trim()).slice(-limit).map(line => { try { return JSON.parse(line) as unknown } catch { return { type: 'invalid_record', status: 'error' } } })
    } finally { await handle.close() }
  }
}
export function redactAdmin(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+)/g, '[REDACTED]')
      .replace(/((?:api[_-]?key|app[_-]?secret|token|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    for (const secret of secrets) if (secret.length >= 4) text = text.split(secret).join('[REDACTED]')
    return text
  }
  if (Array.isArray(value)) return value.map(item => redactAdmin(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|authorization|api.?key/i.test(key) ? '[REDACTED]' : redactAdmin(item, secrets)]))
  return value
}
