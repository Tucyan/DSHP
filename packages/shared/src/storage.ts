import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { z } from 'zod';

export function serializeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('Value is not JSON-serializable');
    return serialized;
  } catch (error) {
    if (error instanceof TypeError && error.message === 'Value is not JSON-serializable') throw error;
    throw new TypeError('Value is not JSON-serializable', { cause: error });
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const serialized = serializeJson(value);
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${serialized}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readJson<T>(filePath: string, schema: z.ZodType<T>): Promise<T> {
  const document: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  return schema.parse(document);
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  const serialized = serializeJson(value);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${serialized}\n`, 'utf8');
}

export interface JsonlParseError {
  line: number;
  raw: string;
  message: string;
  kind: 'syntax' | 'validation';
}

export interface JsonlReadResult<T> {
  records: T[];
  errors: JsonlParseError[];
}

export async function readJsonl<T>(filePath: string, schema: z.ZodType<T>): Promise<JsonlReadResult<T>> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return { records: [], errors: [] };
    throw error;
  }
  const records: T[] = [];
  const errors: JsonlParseError[] = [];
  contents.split(/\r?\n/).forEach((raw, index) => {
    if (!raw.trim()) return;
    try {
      const document: unknown = JSON.parse(raw);
      const parsed = schema.safeParse(document);
      if (parsed.success) {
        records.push(parsed.data);
      } else {
        errors.push({ line: index + 1, raw, message: parsed.error.message, kind: 'validation' });
      }
    } catch (error) {
      errors.push({ line: index + 1, raw, message: error instanceof Error ? error.message : String(error), kind: 'syntax' });
    }
  });
  return { records, errors };
}

export const jsonFileName = (filePath: string): string => basename(filePath);
