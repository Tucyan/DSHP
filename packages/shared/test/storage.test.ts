import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendJsonl, readJsonl, writeJsonAtomic } from '../src/storage.js';

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'personal-growth-shared-'));
}

describe('filesystem utilities', () => {
  it('writes UTF-8 JSON atomically and replaces an existing document', async () => {
    const dir = await tempDirectory();
    const file = join(dir, 'nested', 'state.json');
    await writeJsonAtomic(file, { greeting: '你好', version: 1 });
    await writeJsonAtomic(file, { greeting: '世界', version: 2 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ greeting: '世界', version: 2 });
  });

  it('appends and reads JSONL records in order', async () => {
    const dir = await tempDirectory();
    const file = join(dir, 'events.jsonl');
    await appendJsonl(file, { sequence: 1, text: 'a' });
    await appendJsonl(file, { sequence: 2, text: 'b' });
    await expect(readJsonl<{ sequence: number; text: string }>(file)).resolves.toEqual({
      records: [{ sequence: 1, text: 'a' }, { sequence: 2, text: 'b' }],
      errors: [],
    });
  });

  it('reports malformed JSONL with its line number while retaining valid rows', async () => {
    const dir = await tempDirectory();
    const file = join(dir, 'events.jsonl');
    await appendJsonl(file, { ok: 1 });
    await appendJsonl(file, '{bad json');
    await appendJsonl(file, { ok: 3 });
    const result = await readJsonl<{ ok: number }>(file);
    expect(result.records).toEqual([{ ok: 1 }, { ok: 3 }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ line: 2, raw: '{bad json' });
  });
});
