import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertSafeProjectRoot, readAdminCredential, readOrCreateAdminToken } from './credentials.js'

const BODY_LIMIT = 256 * 1024
const SESSION_MS = 8 * 60 * 60 * 1000
const COOKIE = 'dsh_admin_session'
const MAX_SSE_CLIENTS = 8
const API_RATE_LIMIT = 240
const LOGIN_RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

const routes = new Map<string, ReadonlySet<string>>([
  ['GET', new Set(['/api/status', '/api/model', '/api/sessions', '/api/session', '/api/memory', '/api/memory/document', '/api/memory/revisions', '/api/prompts', '/api/heartbeat', '/api/jobs', '/api/schedules', '/api/diagnostics', '/api/extensions'])],
  ['POST', new Set(['/api/memory', '/api/heartbeat/run', '/api/schedules'])],
  ['PUT', new Set(['/api/model', '/api/prompts', '/api/heartbeat'])],
  ['DELETE', new Set(['/api/schedules'])],
])

export interface AdminBackendInput {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}

export interface AdminBackend {
  handle(input: AdminBackendInput): Promise<unknown>
}

export interface StartAdminServerOptions {
  repoRoot: string
  runtimeRoot: string
  assetsRoot: string
  port?: number
  backend: AdminBackend
}

export interface RunningAdminServer {
  url: string
  close(): Promise<void>
}

interface Session {
  csrfToken: string
  expiresAt: number
  credentialHash: string
}

interface SseClient {
  sessionId: string
  response: ServerResponse
}

class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string) { super(code) }
}

function inside(root: string, target: string): boolean {
  const value = relative(resolve(root), resolve(target))
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

function normalizedPath(value: string): string {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function randomSecret(): string {
  return randomBytes(32).toString('base64url')
}

function cookieValue(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie
  if (!header || header.length > 8192) return undefined
  for (const item of header.split(';')) {
    const [name, ...parts] = item.trim().split('=')
    if (name === COOKIE) return parts.join('=')
  }
  return undefined
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
}

function json(response: ServerResponse, statusCode: number, body: unknown, csrfToken?: string): void {
  if (response.headersSent || response.destroyed) return
  const text = JSON.stringify(body)
  setSecurityHeaders(response)
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Length', Buffer.byteLength(text))
  if (csrfToken) response.setHeader('X-CSRF-Token', csrfToken)
  response.end(text)
}

function safeError(error: unknown): { statusCode: number; code: string } {
  if (error && typeof error === 'object') {
    const status = 'statusCode' in error ? Number(error.statusCode) : NaN
    const code = 'code' in error ? String(error.code) : ''
    if (Number.isInteger(status) && status >= 400 && status <= 599 && /^[a-z][a-z0-9_]{0,63}$/u.test(code)) return { statusCode: status, code }
    if ('name' in error && error.name === 'ZodError') return { statusCode: 400, code: 'invalid_request' }
  }
  return { statusCode: 500, code: 'internal_error' }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > BODY_LIMIT) throw new HttpError(413, 'body_too_large')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > BODY_LIMIT) continue
    chunks.push(bytes)
  }
  if (size > BODY_LIMIT) throw new HttpError(413, 'body_too_large')
  if (size === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new HttpError(400, 'invalid_json') }
}

function requireJson(request: IncomingMessage): void {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new HttpError(415, 'json_required')
}

function rateLimited(store: Map<string, number[]>, key: string, maximum: number): boolean {
  const threshold = Date.now() - RATE_WINDOW_MS
  const current = (store.get(key) ?? []).filter(value => value > threshold)
  current.push(Date.now())
  store.set(key, current)
  return current.length > maximum
}

function staticFile(pathname: string): { name: string; type: string } | undefined {
  if (pathname === '/' || pathname === '/index.html') return { name: 'index.html', type: 'text/html; charset=utf-8' }
  if (pathname === '/app.js') return { name: 'app.js', type: 'text/javascript; charset=utf-8' }
  if (pathname === '/app.css' || pathname === '/styles.css') return { name: pathname.slice(1), type: 'text/css; charset=utf-8' }
  const match = /^\/assets\/([A-Za-z0-9_-]+\.(?:js|css|woff2|png|webp))$/u.exec(pathname)
  if (!match) return undefined
  const extension = match[1].split('.').at(-1)
  const types: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2', png: 'image/png', webp: 'image/webp' }
  return { name: `assets/${match[1]}`, type: types[extension ?? ''] }
}

export async function startAdminServer(options: StartAdminServerOptions): Promise<RunningAdminServer> {
  const repoRoot = await assertSafeProjectRoot(options.repoRoot)
  const assetsRoot = await assertSafeProjectRoot(options.assetsRoot)
  if (!inside(repoRoot, assetsRoot)) throw new Error('admin assets root must be inside the project root')
  const canonicalAssets = await realpath(assetsRoot)
  await readOrCreateAdminToken(repoRoot, options.runtimeRoot)
  const port = options.port ?? 3182
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('admin port is invalid')

  const sessions = new Map<string, Session>()
  const streams = new Set<SseClient>()
  const loginRates = new Map<string, number[]>()
  const apiRates = new Map<string, number[]>()
  const active = new Set<Promise<void>>()
  let authority = ''
  let origin = ''
  let closing = false
  let closePromise: Promise<void> | undefined

  const closeStreams = (sessionId?: string) => {
    for (const stream of [...streams]) {
      if (sessionId && stream.sessionId !== sessionId) continue
      streams.delete(stream)
      stream.response.end()
    }
  }

  const authenticate = async (request: IncomingMessage): Promise<{ id: string; session: Session }> => {
    const id = cookieValue(request)
    const session = id ? sessions.get(id) : undefined
    if (!id || !session || session.expiresAt <= Date.now()) {
      if (id) { sessions.delete(id); closeStreams(id) }
      throw new HttpError(401, 'unauthenticated')
    }
    const current = await readAdminCredential(repoRoot, options.runtimeRoot)
    if (!sameSecret(session.credentialHash, tokenHash(current.token))) {
      sessions.delete(id); closeStreams(id)
      throw new HttpError(401, 'unauthenticated')
    }
    return { id, session }
  }

  const requireWrite = (request: IncomingMessage, session?: Session) => {
    if (request.headers.origin !== origin) throw new HttpError(403, 'invalid_origin')
    requireJson(request)
    if (session && !sameSecret(String(request.headers['x-csrf-token'] ?? ''), session.csrfToken)) throw new HttpError(403, 'invalid_csrf')
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (closing) throw new HttpError(503, 'server_closing')
      if (request.headers.host !== authority) throw new HttpError(400, 'invalid_host')
      const url = new URL(request.url ?? '/', origin)
      const method = request.method ?? 'GET'
      const remote = request.socket.remoteAddress ?? 'unknown'

      if (url.pathname === '/api/login' && method === 'POST') {
        requireWrite(request)
        if (rateLimited(loginRates, remote, LOGIN_RATE_LIMIT)) throw new HttpError(429, 'rate_limited')
        const body = await readJsonBody(request)
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { token?: unknown }).token !== 'string') throw new HttpError(400, 'invalid_request')
        const credential = await readAdminCredential(repoRoot, options.runtimeRoot)
        if (!sameSecret((body as { token: string }).token, credential.token)) throw new HttpError(401, 'invalid_credentials')
        const id = randomSecret()
        const session: Session = { csrfToken: randomSecret(), expiresAt: Date.now() + SESSION_MS, credentialHash: tokenHash(credential.token) }
        sessions.set(id, session)
        response.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`)
        json(response, 200, { csrfToken: session.csrfToken }, session.csrfToken)
        return
      }

      if (url.pathname.startsWith('/api/')) {
        if (rateLimited(apiRates, remote, API_RATE_LIMIT)) throw new HttpError(429, 'rate_limited')
        const authenticated = await authenticate(request)
        if (url.pathname === '/api/auth' && method === 'GET') {
          json(response, 200, { authenticated: true, csrfToken: authenticated.session.csrfToken }, authenticated.session.csrfToken)
          return
        }
        if (url.pathname === '/api/logout' && method === 'POST') {
          requireWrite(request, authenticated.session)
          await readJsonBody(request)
          sessions.delete(authenticated.id)
          closeStreams(authenticated.id)
          response.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
          json(response, 200, { authenticated: false })
          return
        }
        if (url.pathname === '/api/events' && method === 'GET') {
          if (streams.size >= MAX_SSE_CLIENTS) throw new HttpError(429, 'stream_limit')
          setSecurityHeaders(response)
          response.statusCode = 200
          response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
          response.setHeader('Cache-Control', 'no-store')
          response.setHeader('Connection', 'keep-alive')
          response.flushHeaders()
          const stream = { sessionId: authenticated.id, response }
          streams.add(stream)
          response.write('event: refresh\ndata: {"type":"refresh"}\n\n')
          response.on('close', () => streams.delete(stream))
          return
        }
        if (!routes.get(method)?.has(url.pathname)) throw new HttpError(404, 'not_found')
        let body: unknown = undefined
        if (method !== 'GET') {
          requireWrite(request, authenticated.session)
          body = await readJsonBody(request)
        }
        const result = await options.backend.handle({ method, path: url.pathname, query: url.searchParams, body })
        json(response, 200, result, authenticated.session.csrfToken)
        return
      }

      if (method !== 'GET') throw new HttpError(404, 'not_found')
      const selected = staticFile(url.pathname)
      if (!selected) throw new HttpError(404, 'not_found')
      const target = join(assetsRoot, selected.name)
      if (!inside(assetsRoot, target)) throw new HttpError(404, 'not_found')
      const stat = await lstat(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'not_found')
        throw error
      })
      if (!stat.isFile() || stat.isSymbolicLink() || normalizedPath(await realpath(target)) !== normalizedPath(resolve(canonicalAssets, selected.name))) throw new HttpError(404, 'not_found')
      const bytes = await readFile(target)
      setSecurityHeaders(response)
      response.statusCode = 200
      response.setHeader('Content-Type', selected.type)
      response.setHeader('Cache-Control', selected.name === 'index.html' ? 'no-store' : 'public, max-age=300')
      response.setHeader('Content-Length', bytes.length)
      response.end(bytes)
    } catch (error) {
      const safe = safeError(error)
      if (safe.code === 'unauthenticated' && cookieValue(request)) response.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
      json(response, safe.statusCode, { error: { code: safe.code } })
    }
  }

  const server = createServer((request, response) => {
    const task = handle(request, response).finally(() => {
      active.delete(task)
      if (closing) server.closeIdleConnections()
    })
    active.add(task)
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 64

  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolveListen() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('admin server did not bind a TCP port')
  }
  authority = `127.0.0.1:${address.port}`
  origin = `http://${authority}`

  const refresh = setInterval(() => {
    void Promise.all([...streams].map(async stream => {
      try {
        const fake = { headers: { cookie: `${COOKIE}=${stream.sessionId}` } } as IncomingMessage
        await authenticate(fake)
        stream.response.write('event: refresh\ndata: {"type":"refresh"}\n\n')
      } catch { closeStreams(stream.sessionId) }
    }))
  }, 3000)
  refresh.unref()

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    clearInterval(refresh)
    closeStreams()
    closePromise = new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose())
      server.closeIdleConnections()
    }).then(async () => { await Promise.allSettled([...active]) })
    return closePromise
  }

  return { url: origin, close }
}
