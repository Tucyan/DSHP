import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readOrCreateAdminToken, rotateAdminToken } from './credentials.js'

export interface AdminTokenCliOptions {
  repoRoot: string
  runtimeRoot: string
  write(value: string): void
}

export async function runAdminTokenCli(args: readonly string[], options: AdminTokenCliOptions): Promise<void> {
  if (args.length !== 1 || (args[0] !== 'show' && args[0] !== 'rotate')) throw new Error('usage: admin-token <show|rotate>')
  const token = args[0] === 'show'
    ? await readOrCreateAdminToken(options.repoRoot, options.runtimeRoot)
    : await rotateAdminToken(options.repoRoot, options.runtimeRoot)
  options.write(`${token}\n`)
}

export function defaultAdminTokenRoots(environment: Readonly<Record<string, string | undefined>>, moduleUrl = import.meta.url): { repoRoot: string; runtimeRoot: string } {
  const moduleRepoRoot = resolve(dirname(fileURLToPath(moduleUrl)), '../../../..')
  const repoRoot = resolve(environment.PGA_REPO_ROOT ?? moduleRepoRoot)
  return { repoRoot, runtimeRoot: resolve(repoRoot, 'runtime') }
}

function parseDirectArgs(args: readonly string[]): { command: string[]; repoRoot: string; runtimeRoot: string } {
  const command: string[] = []
  let repoRoot = defaultAdminTokenRoots(process.env).repoRoot
  let runtimeRoot: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--repo-root' || value === '--runtime-root') {
      const path = args[index + 1]
      if (!path) throw new Error(`missing value for ${value}`)
      if (value === '--repo-root') repoRoot = resolve(path)
      else runtimeRoot = resolve(path)
      index += 1
    } else command.push(value)
  }
  repoRoot = resolve(repoRoot)
  return { command, repoRoot, runtimeRoot: runtimeRoot ?? resolve(repoRoot, 'runtime') }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invoked === import.meta.url) {
  const parsed = parseDirectArgs(process.argv.slice(2))
  await runAdminTokenCli(parsed.command, { ...parsed, write: value => process.stdout.write(value) })
}
