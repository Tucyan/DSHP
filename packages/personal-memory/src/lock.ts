import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function withWorkspaceLock<T>(workspace: string, operation: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('Workspace lock timeout must be a positive finite number');
  const lockPath = join(workspace, 'memory', '.writer.lock');
  try { if ((await lstat(dirname(lockPath))).isSymbolicLink()) throw new Error(`Symlinked workspace memory root is not allowed: ${dirname(lockPath)}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(dirname(lockPath), { recursive: true });
  const owner = randomUUID(); const started = Date.now();
  while (true) {
    let acquired = false;
    try {
      await mkdir(lockPath, { recursive: false });
      await writeFile(join(lockPath, 'owner'), owner, { encoding: 'utf8', flag: 'wx' });
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (Date.now() - started >= timeoutMs) throw new Error(`Workspace writer lock timeout: ${workspace}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (acquired) { try { return await operation(); } finally { await rm(lockPath, { recursive: true, force: true }); } }
  }
}
