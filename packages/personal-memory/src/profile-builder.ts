import type { MemoryDocument } from './reader.js';

export function renderProfile(documents: readonly MemoryDocument[]): string {
  const active = documents.filter((document) => !document.path.toLocaleLowerCase().startsWith('archive/') && document.metadata.frequency === 'high').sort((a, b) => codeUnitCompare(a.path, b.path));
  const lines = ['# Profile', '', 'High-frequency active memories:', ''];
  for (const document of active) lines.push(`## ${escapeMarkdown(document.metadata.summary)}`, `<!-- source: ${escapeMarkdown(document.path)} -->`, '', document.content, '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

export const buildProfile = renderProfile;
function codeUnitCompare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function escapeMarkdown(value: string): string { return value.replaceAll('\\', '\\\\').replace(/[\r\n]/g, ' ').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('(', '\\(').replaceAll(')', '\\)'); }
