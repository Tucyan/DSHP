import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from '../src/storage.js';

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

  it('serializes top-level strings as JSON and rejects invalid top-level values', async () => {
    const dir = await tempDirectory();
    const file = join(dir, 'values.jsonl');
    await appendJsonl(file, 'hello');
    expect(JSON.parse((await readFile(file, 'utf8')).trim())).toBe('hello');
    await expect(appendJsonl(file, undefined)).rejects.toThrow(/JSON/i);
    await expect(writeJsonAtomic(join(dir, 'invalid.json'), BigInt(1))).rejects.toThrow(/JSON/i);
  });

  it('validates JSON documents and reports JSONL schema failures', async () => {
    const dir = await tempDirectory();
    const file = join(dir, 'events.jsonl');
    const document = join(dir, 'state.json');
    const schema = z.object({ ok: z.number() });
    await writeFile(document, '{"ok":"wrong"}', 'utf8');
    await writeFile(file, '{"ok":1}\n{bad json\n{"ok":"wrong"}\n', 'utf8');
    await expect(readJson(document, schema)).rejects.toThrow();
    const result = await readJsonl(file, schema);
    expect(result.records).toEqual([{ ok: 1 }]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 2, kind: 'syntax' }),
      expect.objectContaining({ line: 3, kind: 'validation' }),
    ]));
  });

  it('appends and reads JSONL records in order', async () => {
    const dir = await tempDirectory();
    const file = join(dir, 'events.jsonl');
    await appendJsonl(file, { sequence: 1, text: 'a' });
    await appendJsonl(file, { sequence: 2, text: 'b' });
    const schema = z.object({ sequence: z.number(), text: z.string() });
    await expect(readJsonl(file, schema)).resolves.toEqual({
      records: [{ sequence: 1, text: 'a' }, { sequence: 2, text: 'b' }],
      errors: [],
    });
  });

  it('reports malformed JSONL with its line number while retaining valid rows', async () => {
    const dir = await tempDirectory();
    const file = join(dir, 'events.jsonl');
    await writeFile(file, '{"ok":1}\n{bad json\n{"ok":3}\n', 'utf8');
    const result = await readJsonl(file, z.object({ ok: z.number() }));
    expect(result.records).toEqual([{ ok: 1 }, { ok: 3 }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ line: 2, raw: '{bad json' });
  });

  it('returns empty for a missing JSONL file but rethrows other filesystem errors', async () => {
    const dir = await tempDirectory();
    const schema = z.object({ ok: z.number() });
    await expect(readJsonl(join(dir, 'missing.jsonl'), schema)).resolves.toEqual({ records: [], errors: [] });
    await expect(readJsonl(dir, schema)).rejects.toThrow();
  });
});
