import type { MemoryDocument } from './reader.js';

export function renderIndex(documents: readonly MemoryDocument[]): string {
  const active = documents.filter((document) => !document.path.toLocaleLowerCase().startsWith('archive/')).sort((a, b) => codeUnitCompare(a.path, b.path));
  const lines = ['# Memory Index', '', 'Active semantic memory documents:', ''];
  for (const document of active) lines.push(`- [${escapeMarkdown(document.metadata.summary)}](./${escapeMarkdown(document.path)}) — ${document.metadata.category}`);
  return `${lines.join('\n')}\n`;
}

export const buildIndex = renderIndex;
function codeUnitCompare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function escapeMarkdown(value: string): string { return value.replaceAll('\\', '\\\\').replace(/[\r\n]/g, ' ').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('(', '\\(').replaceAll(')', '\\)'); }
