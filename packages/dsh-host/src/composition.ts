import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

export interface HostPatchOptions {
  hostName?: string
  hostConfig?: Record<string, unknown>
}

export interface EntryRow { id: string; name: string; config?: Record<string, unknown> }

/** The only patch contract owned by this package: insert schedule before the host. */
export function buildHostPatch(options: HostPatchOptions = {}): { insert: EntryRow[] } {
  return {
    insert: [
      { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
      { id: 'personal-growth-host', name: options.hostName ?? '@personal-growth/dsh-host', config: options.hostConfig },
    ],
  }
}

export function assertRequiredComposition(entries: readonly { id?: string; name?: string }[]): void {
  if (!entries.some(entry => entry.id === 'schedule' && entry.name === '@deepseek-ai/dsh-schedule')) throw new Error('DSH host requires the public schedule plugin')
  if (!entries.some(entry => entry.id === 'personal-growth-host')) throw new Error('DSH host entry is missing')
}

export function basePatchPath(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')
}

export function hostModulePath(): string {
  return pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'plugin.js')).href
}

export function loadBaseAndHostPatches(hostConfig: Record<string, unknown> = {}): unknown[] {
  const base = loadOverlayPatches('personal-growth', basePatchPath())
  return [...base, buildHostPatch({ hostName: hostModulePath(), hostConfig })]
}

export async function bootPersonalGrowth(configPath: string, hostConfig: Record<string, unknown> = {}): Promise<Context> {
  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  return boot('personal-growth', configPath, loadBaseAndHostPatches(hostConfig) as never[])
}
