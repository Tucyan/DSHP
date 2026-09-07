import { execFileSync } from 'node:child_process'

type PowerShellName = 'pwsh' | 'powershell'
export type PowerShellLookup = (name: PowerShellName) => string | undefined

function lookupPowerShellOnPath(name: PowerShellName): string | undefined {
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which'
    const result = execFileSync(locator, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return result.split(/\r?\n/, 1)[0] || undefined
  } catch {
    return undefined
  }
}

export function resolvePowerShell(lookup: PowerShellLookup = lookupPowerShellOnPath): string {
  const pwsh = lookup('pwsh')
  if (pwsh) return pwsh

  const powershell = lookup('powershell')
  if (powershell) return powershell

  throw new Error('No PowerShell executable found. Install PowerShell 7 (pwsh) or Windows PowerShell (powershell).')
}
