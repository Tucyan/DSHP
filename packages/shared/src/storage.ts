import { randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${typeof value === 'string' ? value : JSON.stringify(value)}\n`, 'utf8');
}

export interface JsonlParseError {
  line: number;
  raw: string;
  message: string;
}

export interface JsonlReadResult<T> {
  records: T[];
  errors: JsonlParseError[];
}

export async function readJsonl<T>(filePath: string): Promise<JsonlReadResult<T>> {
  try {
    await access(filePath);
  } catch {
    return { records: [], errors: [] };
  }
  const contents = await readFile(filePath, 'utf8');
  const records: T[] = [];
  const errors: JsonlParseError[] = [];
  contents.split(/\r?\n/).forEach((raw, index) => {
    if (!raw.trim()) return;
    try {
      records.push(JSON.parse(raw) as T);
    } catch (error) {
      errors.push({ line: index + 1, raw, message: error instanceof Error ? error.message : String(error) });
    }
  });
  return { records, errors };
}

export const jsonFileName = (filePath: string): string => basename(filePath);
