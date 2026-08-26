import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildQqProfileStates } from './qq-profile-state.mjs';

const index = process.argv.indexOf('--peer-id');
const peerId = index >= 0 ? process.argv[index + 1] : undefined;
if (!peerId) throw new Error('render-qq-profile.mjs requires --peer-id');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = await import(pathToFileURL(path.join(repoRoot, 'packages/qq-adapter/dist/tencent.js')).href);
const patch = generator.buildTencentQqProfilePatch(peerId);
const states = buildQqProfileStates('', patch);
process.stdout.write(process.argv.includes('--disabled') ? states.disabled : states.enabled);
