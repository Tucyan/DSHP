import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { bootPersonalGrowth } from './composition.js'

const workspace = resolve(process.env.PERSONAL_GROWTH_WORKSPACE ?? resolve(process.cwd(), 'workspace'))
process.env.PERSONAL_GROWTH_WORKSPACE = workspace
const configPath = resolve(process.env.DSH_HOME ?? resolve(process.cwd(), 'runtime', 'dsh-home'), 'profiles', 'personal-growth', 'cordis.yml')
await mkdir(resolve(configPath, '..'), { recursive: true })
await writeFile(configPath, '[]\n', { flag: 'wx' }).catch(error => {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
})
const ctx = await bootPersonalGrowth(configPath, {
  appId: process.env.QQBOT_APP_ID,
  appSecret: process.env.QQBOT_APP_SECRET,
  allowedPeerId: process.env.QQBOT_ALLOWED_PEER_ID,
  accountId: process.env.QQBOT_ACCOUNT_ID,
})
const dispose = (ctx as unknown as { dispose?: () => Promise<void> }).dispose
if (!dispose) throw new Error('DSH boot context does not expose public dispose()')
process.once('SIGINT', () => { void dispose.call(ctx) })
process.once('SIGTERM', () => { void dispose.call(ctx) })
