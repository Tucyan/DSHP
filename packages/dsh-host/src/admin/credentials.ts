import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

const CREDENTIAL_DIRECTORY = 'credentials'
const CREDENTIAL_FILE = 'admin-token.json'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export interface AdminCredential {
  version: 1
  token: string
  rotatedAt: string
}

function pathInside(root: string, target: string): boolean {
  const value = relative(resolve(root), resolve(target))
  return value !== '..' && value !== '' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

async function assertNoSymlink(value: string): Promise<void> {
  const absolute = resolve(value)
  const parsed = parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error('admin path must not contain symlinks or junctions')
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
}

function normalized(value: string): string {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function assertNotDefaultAgentHome(root: string): void {
  for (const home of [process.env.USERPROFILE, process.env.HOME].filter(Boolean) as string[]) {
    for (const name of ['.dsh', '.agents']) {
      const unsafe = resolve(home, name)
      const value = relative(unsafe, root)
      if (value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))) throw new Error('default agent homes cannot be administered')
    }
  }
}

export async function assertSafeProjectRoot(root: string, options: { mustExist?: boolean } = {}): Promise<string> {
  if (!isAbsolute(root)) throw new Error('admin path must be absolute')
  const absolute = resolve(root)
  assertNotDefaultAgentHome(absolute)
  await assertNoSymlink(absolute)
  try {
    const stat = await lstat(absolute)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('admin project root must be a directory')
    const canonical = await realpath(absolute)
    if (normalized(canonical) !== normalized(absolute)) throw new Error('admin project root must be canonical')
    return absolute
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && options.mustExist === false) return absolute
    throw error
  }
}

async function credentialPath(repoRoot: string, runtimeRoot: string): Promise<string> {
  const repository = await assertSafeProjectRoot(repoRoot, { mustExist: true })
  const root = await assertSafeProjectRoot(runtimeRoot, { mustExist: false })
  if (normalized(root) !== normalized(join(repository, 'runtime'))) throw new Error('admin runtime root must be the ignored project runtime directory')
  await mkdir(root, { recursive: true })
  await assertNoSymlink(root)
  const directory = join(root, CREDENTIAL_DIRECTORY)
  await mkdir(directory, { recursive: true })
  await assertNoSymlink(directory)
  const file = join(directory, CREDENTIAL_FILE)
  if (!pathInside(root, file)) throw new Error('admin credential path escaped runtime root')
  return file
}

function parseCredential(input: unknown): AdminCredential {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('admin credential file is malformed')
  const value = input as Record<string, unknown>
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'rotatedAt,token,version' || value.version !== 1 || typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token) || typeof value.rotatedAt !== 'string' || Number.isNaN(Date.parse(value.rotatedAt))) {
    throw new Error('admin credential file is malformed')
  }
  return { version: 1, token: value.token, rotatedAt: value.rotatedAt }
}

async function readCredential(file: string): Promise<AdminCredential | undefined> {
  try {
    const stat = await lstat(file)
    if (stat.isSymbolicLink()) throw new Error('admin credential file must not be a symlink')
    return parseCredential(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeCredential(file: string, credential: AdminCredential): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(credential)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function createCredential(file: string, credential: AdminCredential): Promise<void> {
  await writeFile(file, `${JSON.stringify(credential)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}

export async function readOrCreateAdminToken(repoRoot: string, runtimeRoot: string): Promise<string> {
  const file = await credentialPath(repoRoot, runtimeRoot)
  const current = await readCredential(file)
  if (current) return current.token
  const created: AdminCredential = { version: 1, token: randomBytes(32).toString('base64url'), rotatedAt: new Date().toISOString() }
  try {
    await createCredential(file, created)
    return created.token
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
    const raced = await readCredential(file)
    if (!raced) throw new Error('admin credential creation raced with an invalid file')
    return raced.token
  }
}

export async function readAdminCredential(repoRoot: string, runtimeRoot: string): Promise<AdminCredential> {
  const file = await credentialPath(repoRoot, runtimeRoot)
  const value = await readCredential(file)
  if (!value) throw new Error('admin credential file is missing')
  return value
}

export async function rotateAdminToken(repoRoot: string, runtimeRoot: string): Promise<string> {
  const file = await credentialPath(repoRoot, runtimeRoot)
  const next: AdminCredential = { version: 1, token: randomBytes(32).toString('base64url'), rotatedAt: new Date().toISOString() }
  await writeCredential(file, next)
  return next.token
}

export function isAdminToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}
