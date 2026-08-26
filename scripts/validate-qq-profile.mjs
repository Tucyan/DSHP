import { readFileSync } from 'node:fs';
import process from 'node:process';

export function assertManagedQqProfile(content, expectedPeer) {
  if (!expectedPeer || [...expectedPeer].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || '\\"[]:'.includes(character))) throw new Error('managed QQ profile binding mismatch');
  const ids = content.match(/^\s*-\s+id:\s+im-qqbot\s*$/gmu) ?? [];
  const names = content.match(/^\s*name:\s+'@tencent-connect\/dsh-qqbot'\s*$/gmu) ?? [];
  const peers = [...content.matchAll(/^\s*c2cAllow:\s*\["([^"]*)"\]\s*$/gmu)];
  if (ids.length !== 1 || names.length !== 1 || peers.length !== 1 || peers[0][1] !== expectedPeer || !/^\s*disabled:\s+false\s*$/mu.test(content) || !/^\s*c2cMode:\s+allowlist\s*$/mu.test(content) || !/^\s*groupMode:\s+disabled\s*$/mu.test(content) || /(^|\n)\s*-\s+insert:/u.test(content)) throw new Error('managed QQ profile binding mismatch');
}

if (process.argv[1]?.endsWith('validate-qq-profile.mjs')) {
  const fileIndex = process.argv.indexOf('--file');
  const peerIndex = process.argv.indexOf('--peer-id');
  if (fileIndex < 0 || peerIndex < 0) throw new Error('validate-qq-profile.mjs requires --file and --peer-id');
  assertManagedQqProfile(readFileSync(process.argv[fileIndex + 1], 'utf8'), process.argv[peerIndex + 1]);
}
