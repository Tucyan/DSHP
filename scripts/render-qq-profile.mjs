import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const index = process.argv.indexOf('--peer-id');
const peerId = index >= 0 ? process.argv[index + 1] : undefined;
if (!peerId) throw new Error('render-qq-profile.mjs requires --peer-id');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = await import(pathToFileURL(path.join(repoRoot, 'packages/qq-adapter/dist/tencent.js')).href);
process.stdout.write(generator.buildTencentQqProfilePatch(peerId));
