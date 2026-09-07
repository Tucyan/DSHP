import { describe, expect, it } from 'vitest'
import { resolvePowerShell } from './powershell.js'

describe('PowerShell executable resolution', () => {
  it('prefers pwsh when both supported shells are available', () => {
    expect(resolvePowerShell((name) => name === 'pwsh' ? 'C:/PowerShell/7/pwsh.exe' : 'C:/Windows/powershell.exe')).toBe('C:/PowerShell/7/pwsh.exe')
  })

  it('falls back to Windows PowerShell when pwsh is unavailable', () => {
    expect(resolvePowerShell((name) => name === 'powershell' ? 'C:/Windows/powershell.exe' : undefined)).toBe('C:/Windows/powershell.exe')
  })

  it('reports both supported shell names when neither is available', () => {
    expect(() => resolvePowerShell(() => undefined)).toThrow(/No PowerShell executable found.*pwsh.*powershell/i)
  })
})
