import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { startAdminServer } from '../src/admin/server.js'
import { readOrCreateAdminToken, rotateAdminToken } from '../src/admin/credentials.js'
import { defaultAdminTokenRoots, runAdminTokenCli } from '../src/admin/token-cli.js'

type Running = { close: () => Promise<void>; url: string; root: string }
const running: Running[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(async ({ close, root }) => {
    await close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }))
})

async function makeServer(backend: { handle: (input: { method: string; path: string; query: URLSearchParams; body: unknown }) => Promise<unknown> }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-admin-'))
  const runtimeRoot = join(root, 'runtime')
  const assetsRoot = join(root, 'assets')
  await mkdir(assetsRoot, { recursive: true })
  await mkdir(join(assetsRoot, 'assets'))
  await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><script src="/app.js"></script>')
  await writeFile(join(assetsRoot, 'app.js'), 'console.log("ok")')
  await writeFile(join(assetsRoot, 'styles.css'), 'body { color: black }')
  await writeFile(join(assetsRoot, 'assets/app-Ab_12.js'), 'console.log("hashed")')
  await writeFile(join(assetsRoot, 'secret.json'), '{"nope":true}')
  const server = await startAdminServer({ repoRoot: root, runtimeRoot, assetsRoot, port: 0, backend })
  running.push({ ...server, root })
  return { ...server, root, token: await readOrCreateAdminToken(root, runtimeRoot) }
}

async function http(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const parsed = new URL(url)
  return await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolvePromise, reject) => {
    const req = request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: options.method, headers: options.headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

async function openSse(url: string, cookie: string) {
  const parsed = new URL(url)
  return await new Promise<{ first: Promise<string>; closed: Promise<void> }>((resolvePromise, reject) => {
    const req = request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, headers: { Cookie: cookie } })
    req.on('response', response => {
      let resolveFirst!: (value: string) => void
      const first = new Promise<string>(resolve => { resolveFirst = resolve })
      const closed = new Promise<void>(resolve => response.once('close', resolve))
      response.once('data', chunk => resolveFirst(Buffer.from(chunk).toString('utf8')))
      resolvePromise({ first, closed })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('authenticated admin server', () => {
  it('rejects unauthenticated API calls and serves only compiled assets', async () => {
    const app = await makeServer({ handle: async () => ({ ok: true }) })
    expect((await http(`${app.url}/api/status`)).status).toBe(401)
    expect((await http(`${app.url}/api/model`)).status).toBe(401)
    expect((await http(`${app.url}/`)).status).toBe(200)
    expect((await http(`${app.url}/assets/app-Ab_12.js`)).status).toBe(200)
    expect((await http(`${app.url}/secret.json`)).status).toBe(404)
  })

  it('requires exact origin, csrf, and dispatches only explicit routes', async () => {
    const calls: unknown[] = []
    const app = await makeServer({ handle: async input => { calls.push(input); return { accepted: true } } })
    const login = await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: '127.0.0.1:' + new URL(app.url).port, Origin: 'http://127.0.0.1:' + new URL(app.url).port, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) })
    expect(login.status).toBe(200)
    const cookie = String(login.headers['set-cookie']).split(';')[0]
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken
    const status = await http(`${app.url}/api/status`, { headers: { Cookie: cookie } })
    expect(status.status).toBe(200)
    const mutation = await http(`${app.url}/api/status`, { method: 'POST', headers: { Host: '127.0.0.1:' + new URL(app.url).port, Origin: 'http://127.0.0.1:' + new URL(app.url).port, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: '{}' })
    expect(mutation.status).toBe(404)
    const memory = await http(`${app.url}/api/memory`, { method: 'POST', headers: { Host: '127.0.0.1:' + new URL(app.url).port, Origin: 'http://127.0.0.1:' + new URL(app.url).port, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: '{"text":"x"}' })
    expect(memory.status).toBe(200)
    const model = await http(`${app.url}/api/model`, { method: 'PUT', headers: { Host: '127.0.0.1:' + new URL(app.url).port, Origin: 'http://127.0.0.1:' + new URL(app.url).port, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: '{"selection":{"provider":"deepseek-official","model":"deepseek-v4.1-flash-expires-on-0910"},"expectedRevision":0}' })
    expect(model.status).toBe(200)
    expect(calls).toHaveLength(3)
    expect(calls.map(value => (value as { path: string }).path)).toEqual(['/api/status', '/api/memory', '/api/model'])
  })

  it('sets an eight-hour strict cookie and exposes auth without returning the admin token', async () => {
    const app = await makeServer({ handle: async () => ({ ok: true }) })
    const authority = `127.0.0.1:${new URL(app.url).port}`
    const login = await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: authority, Origin: `http://${authority}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) })
    expect(login.status).toBe(200)
    expect(login.body).not.toContain(app.token)
    expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict; Max-Age=28800/u)
    const cookie = String(login.headers['set-cookie']).split(';')[0]
    const auth = await http(`${app.url}/api/auth?token=${encodeURIComponent(app.token)}`, { headers: { Cookie: cookie } })
    expect(auth.status).toBe(200)
    expect(JSON.parse(auth.body)).toMatchObject({ authenticated: true, csrfToken: expect.any(String) })
    expect(auth.body).not.toContain(app.token)
  })

  it('rejects non-local authority, cross-origin writes, missing csrf, and oversized JSON', async () => {
    const app = await makeServer({ handle: async () => ({ ok: true }) })
    const authority = `127.0.0.1:${new URL(app.url).port}`
    expect((await http(`${app.url}/`, { headers: { Host: `localhost:${new URL(app.url).port}` } })).status).toBe(400)
    const crossOrigin = await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: authority, Origin: 'http://localhost:3182', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) })
    expect(crossOrigin.status).toBe(403)
    const login = await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: authority, Origin: `http://${authority}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) })
    const cookie = String(login.headers['set-cookie']).split(';')[0]
    const noCsrf = await http(`${app.url}/api/memory`, { method: 'POST', headers: { Host: authority, Origin: `http://${authority}`, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })
    expect(noCsrf.status).toBe(403)
    const tooLarge = await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: authority, Origin: `http://${authority}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(256 * 1024) }) })
    expect(tooLarge.status).toBe(413)
  })

  it('maps backend errors to safe codes without leaking their messages', async () => {
    const app = await makeServer({ handle: async () => { const error = new Error('secret filesystem path'); Object.assign(error, { statusCode: 409, code: 'memory_conflict' }); throw error } })
    const authority = `127.0.0.1:${new URL(app.url).port}`
    const login = await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: authority, Origin: `http://${authority}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) })
    const response = await http(`${app.url}/api/status`, { headers: { Cookie: String(login.headers['set-cookie']).split(';')[0] } })
    expect(response.status).toBe(409)
    expect(response.body).toContain('memory_conflict')
    expect(response.body).not.toContain('secret filesystem path')
  })

  it('rotates credentials and rejects the old token', async () => {
    const app = await makeServer({ handle: async () => ({ ok: true }) })
    const next = await rotateAdminToken(app.root, join(app.root, 'runtime'))
    expect(next).not.toBe(app.token)
    const oldLogin = await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: '127.0.0.1:' + new URL(app.url).port, Origin: 'http://127.0.0.1:' + new URL(app.url).port, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) })
    expect(oldLogin.status).toBe(401)
    const newLogin = await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: '127.0.0.1:' + new URL(app.url).port, Origin: 'http://127.0.0.1:' + new URL(app.url).port, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: next }) })
    expect(newLogin.status).toBe(200)
  })

  it('revokes an existing session when credentials rotate and on logout', async () => {
    const app = await makeServer({ handle: async () => ({ ok: true }) })
    const authority = `127.0.0.1:${new URL(app.url).port}`
    const login = await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: authority, Origin: `http://${authority}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) })
    const cookie = String(login.headers['set-cookie']).split(';')[0]
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken
    await rotateAdminToken(app.root, join(app.root, 'runtime'))
    const revoked = await http(`${app.url}/api/status`, { headers: { Cookie: cookie } })
    expect(revoked.status).toBe(401)
    expect(String(revoked.headers['set-cookie'])).toContain('Max-Age=0')

    const next = await readOrCreateAdminToken(app.root, join(app.root, 'runtime'))
    const second = await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: authority, Origin: `http://${authority}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: next }) })
    const secondCookie = String(second.headers['set-cookie']).split(';')[0]
    const secondCsrf = (JSON.parse(second.body) as { csrfToken: string }).csrfToken
    const logout = await http(`${app.url}/api/logout`, { method: 'POST', headers: { Host: authority, Origin: `http://${authority}`, Cookie: secondCookie, 'X-CSRF-Token': secondCsrf, 'Content-Type': 'application/json' }, body: '{}' })
    expect(logout.status).toBe(200)
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0')
    expect((await http(`${app.url}/api/auth`, { headers: { Cookie: secondCookie } })).status).toBe(401)
    expect(csrf).not.toBe(secondCsrf)
  })

  it('streams refresh metadata and closes that session stream on logout', async () => {
    const app = await makeServer({ handle: async () => ({ ok: true }) })
    const authority = `127.0.0.1:${new URL(app.url).port}`
    const login = await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: authority, Origin: `http://${authority}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) })
    const cookie = String(login.headers['set-cookie']).split(';')[0]
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken
    const events = await openSse(`${app.url}/api/events`, cookie)
    expect(await events.first).toContain('event: refresh\ndata: {"type":"refresh"}')
    await http(`${app.url}/api/logout`, { method: 'POST', headers: { Host: authority, Origin: `http://${authority}`, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: '{}' })
    await events.closed
  })

  it('rate limits repeated login attempts', async () => {
    const app = await makeServer({ handle: async () => ({ ok: true }) })
    const authority = `127.0.0.1:${new URL(app.url).port}`
    let last = 0
    for (let index = 0; index < 11; index += 1) {
      last = (await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: authority, Origin: `http://${authority}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'A'.repeat(43) }) })).status
    }
    expect(last).toBe(429)
  })

  it('drains in-flight backend work and supports repeated close calls', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolvePending => { release = resolvePending })
    const app = await makeServer({ handle: async () => { await pending; return { ok: true } } })
    const authority = `127.0.0.1:${new URL(app.url).port}`
    const login = await http(`${app.url}/api/login`, { method: 'POST', headers: { Host: authority, Origin: `http://${authority}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) })
    const inFlight = http(`${app.url}/api/status`, { headers: { Cookie: String(login.headers['set-cookie']).split(';')[0] } })
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
    let closed = false
    const close = app.close().then(() => { closed = true })
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
    expect(closed).toBe(false)
    release()
    expect((await inFlight).status).toBe(200)
    await close
    await app.close()
  })
})

describe('admin credentials and CLI', () => {
  it('creates one stable 32-byte token under the project runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-admin-token-'))
    try {
      const runtimeRoot = join(root, 'runtime')
      const tokens = await Promise.all(Array.from({ length: 4 }, () => readOrCreateAdminToken(root, runtimeRoot)))
      expect(new Set(tokens).size).toBe(1)
      expect(Buffer.from(tokens[0], 'base64url')).toHaveLength(32)
      const stored = JSON.parse(await readFile(join(runtimeRoot, 'credentials/admin-token.json'), 'utf8')) as { token: string }
      expect(stored.token).toBe(tokens[0])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('prints only the token for explicit show and rotate commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-admin-cli-'))
    try {
      const runtimeRoot = join(root, 'runtime'); const output: string[] = []
      await runAdminTokenCli(['show'], { repoRoot: root, runtimeRoot, write: value => output.push(value) })
      const first = output.at(-1)!
      await runAdminTokenCli(['rotate'], { repoRoot: root, runtimeRoot, write: value => output.push(value) })
      expect(output).toHaveLength(2)
      expect(output.every(value => /^[A-Za-z0-9_-]{43}\n$/u.test(value))).toBe(true)
      expect(output[1]).not.toBe(first)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('refuses credential roots outside the ignored project runtime directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-admin-root-'))
    try {
      await expect(readOrCreateAdminToken(root, join(root, 'other-runtime'))).rejects.toThrow(/runtime root/u)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('derives CLI roots from its module location with an explicit environment override', () => {
    const moduleUrl = pathToFileURL(join('C:/projects/pga', 'packages/dsh-host/dist/admin/token-cli.js')).href
    expect(defaultAdminTokenRoots({}, moduleUrl)).toEqual({ repoRoot: resolve('C:/projects/pga'), runtimeRoot: resolve('C:/projects/pga/runtime') })
    expect(defaultAdminTokenRoots({ PGA_REPO_ROOT: 'C:/configured/pga' }, moduleUrl)).toEqual({ repoRoot: resolve('C:/configured/pga'), runtimeRoot: resolve('C:/configured/pga/runtime') })
  })
})
