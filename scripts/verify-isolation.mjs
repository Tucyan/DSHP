import path from 'node:path';
import process from 'node:process';
import { validateIsolatedPathsAsync, resolveIsolatedPaths } from '../packages/dsh-adapter/dist/paths.js';

const root = path.resolve(process.env.PGA_REPO_ROOT || path.resolve('.'));
await validateIsolatedPathsAsync(resolveIsolatedPaths(root));
process.stdout.write('Isolation verified: canonical runtime paths are repository-local and default homes are untouched.\n');
