import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.env.PGA_REPO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const runtime = path.join(root, 'runtime');
const paths = [
  path.join(runtime, 'dsh-home'), path.join(runtime, 'agents-home'), path.join(root, 'workspace'),
  path.join(runtime, 'plugins'), path.join(runtime, 'skills'), path.join(runtime, 'sessions'),
  path.join(runtime, 'storage'), path.join(runtime, 'credentials'),
];

const isOutside = (base, candidate) => {
  const relative = path.relative(base, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};
async function nearestReal(value) {
  let current = value;
  while (true) {
    try { return await fs.realpath(current); }
    catch (error) {
      if (error?.code === 'ENOENT' && path.dirname(current) !== current) { current = path.dirname(current); continue; }
      throw error;
    }
  }
}

const canonicalRoot = await nearestReal(root);
for (const value of paths) {
  const candidate = path.resolve(value);
  if (isOutside(root, candidate)) throw new Error('isolated path escapes repository lexically');
  const canonicalAncestor = await nearestReal(candidate);
  if (isOutside(canonicalRoot, canonicalAncestor)) throw new Error('isolated path resolves outside repository');
  try {
    if ((await fs.lstat(candidate)).isSymbolicLink()) throw new Error('isolated path must not be a symlink or junction');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
process.stdout.write('Isolation verified: canonical runtime paths are repository-local and default homes are untouched.\n');
