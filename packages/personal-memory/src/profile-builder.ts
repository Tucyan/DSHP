import type { MemoryDocument } from './reader.js';

export function renderProfile(documents: readonly MemoryDocument[]): string {
  const active = documents.filter((document) => !document.path.toLocaleLowerCase().startsWith('archive/') && document.metadata.frequency === 'high').sort((a, b) => a.path.localeCompare(b.path));
  const lines = ['# Profile', '', 'High-frequency active memories:', ''];
  for (const document of active) lines.push(`## ${document.metadata.summary}`, `<!-- source: ${document.path} -->`, '', document.content, '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

export const buildProfile = renderProfile;
