import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendJsonl, redactTrace } from '@personal-growth/shared';

export interface SkillDraft { name: string; description: string; instructions: string; positiveTriggers: string[]; negativeTriggers: string[]; }
export interface SkillResult { path: string; version: number; created: boolean; }
export interface PluginProposal { name: string; capabilityGap: string; design: string; tests?: string[]; }
export interface PluginProposalResult { path: string; version: number; }
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const privacyPattern = /(secret|token|password|api[_ -]?key|credential|private[_ -]?key|连续.{0,8}(天|日)|用户.{0,10}(喜欢|偏好|失败|习惯)|(the user|user).{0,20}(likes|prefers|failed|habit|secret))/iu;

async function assertSafeDirectory(target: string, root: string): Promise<void> {
  const resolvedTarget = path.resolve(target); const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('extension path escapes its isolated root');
  const rootCanonical = await nearestExisting(root); const targetCanonical = await nearestExisting(target);
  const canonicalRelative = path.relative(rootCanonical, targetCanonical);
  if (canonicalRelative.startsWith(`..${path.sep}`) || canonicalRelative === '..' || path.isAbsolute(canonicalRelative)) throw new Error('extension path resolves outside its isolated root');
  let current = resolvedTarget;
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('extension path may not contain symlinks'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current || current === resolvedRoot) break; current = parent;
  }
}
async function nearestExisting(value: string): Promise<string> {
  let current = path.resolve(value);
  while (true) {
    try { return path.resolve(await realpath(current)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = path.dirname(current); if (parent === current) throw error; current = parent; }
  }
}

export function validateSkillDraft(input: SkillDraft): SkillDraft {
  if (!namePattern.test(input.name) || input.name.length > 64) throw new Error('skill name must be lowercase kebab-case');
  if (input.description.length > 240 || input.instructions.length < 1 || input.instructions.length > 16_384 || input.positiveTriggers.length > 20 || input.negativeTriggers.length > 20 || input.positiveTriggers.some((item) => !item.trim() || item.length > 200) || input.negativeTriggers.some((item) => !item.trim() || item.length > 200)) throw new Error('skill fields exceed safe bounds');
  if (/\r|\n|:\s/u.test(input.description) || !/^Use when\s+[^.]+\.$/u.test(input.description.trim())) throw new Error('skill description must be a single-line narrow trigger sentence starting with Use when and ending with a period');
  if (/Use when\s+(anything|everything|the user sends|there is|working)/iu.test(input.description)) throw new Error('skill trigger is too broad');
  if (privacyPattern.test(`${input.description}\n${input.instructions}\n${input.positiveTriggers.join('\n')}\n${input.negativeTriggers.join('\n')}`)) throw new Error('skill must not contain personal facts or secrets');
  if (!input.instructions.includes('Input:') || !input.instructions.includes('Output:') || !input.instructions.includes('Stop')) throw new Error('skill requires explicit Input, Output, and Stop behavior');
  if (!input.positiveTriggers.length || !input.negativeTriggers.length) throw new Error('skill requires positive and negative triggers');
  return { ...input, description: input.description.trim(), instructions: input.instructions.trim() };
}
function skillText(input: SkillDraft): string { return `---\nname: ${input.name}\ndescription: ${input.description}\n---\n\n# ${input.name}\n\n${input.instructions}\n\n## Trigger boundaries\n\nPositive triggers: ${input.positiveTriggers.join('; ')}\nNegative triggers: ${input.negativeTriggers.join('; ')}\n`; }
function proposalText(input: PluginProposal, version: number): string { return `# Plugin proposal: ${input.name} v${version}\n\nStatus: PROPOSED; requires human approval.\n\n## Capability gap\n${input.capabilityGap}\n\n## Design\n${input.design}\n\n## Tests\n${(input.tests ?? []).map((item) => `- ${item}`).join('\n') || '- Add contract, failure, and integration tests before activation.'}\n`; }

export class ExtensionWriter {
  constructor(private readonly agentsHome: string, private readonly runtimeRoot: string, private readonly tracePath = path.join(runtimeRoot, 'traces.jsonl')) {}
  async createSkill(input: SkillDraft, at = new Date().toISOString()): Promise<SkillResult> {
    const draft = validateSkillDraft(input); const isolatedHome = path.resolve(this.agentsHome); const extensionRoot = path.dirname(path.resolve(this.runtimeRoot)); await assertSafeDirectory(isolatedHome, extensionRoot); const base = path.resolve(isolatedHome, 'skills'); await assertSafeDirectory(base, isolatedHome); await mkdir(base, { recursive: true });
    for (let version = 1; version <= 1000; version++) {
      const directory = path.join(base, `${draft.name}-v${version}`); const target = path.join(directory, 'SKILL.md');
      try {
        const existing = await readFile(target, 'utf8');
        if (existing === skillText(draft)) return { path: target, version, created: false };
        continue;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await mkdir(directory, { recursive: true });
      const reservation = path.join(directory, '.skill-writer.lock');
      try { await writeFile(reservation, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        for (let retry = 0; retry < 100; retry++) { try { if (await readFile(target, 'utf8') === skillText(draft)) return { path: target, version, created: false }; } catch (readError) { if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError; } await new Promise((resolve) => setTimeout(resolve, 5)); }
        continue;
      }
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, skillText(draft), { encoding: 'utf8', flag: 'wx' });
        try { await rename(temporary, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { await rm(temporary, { force: true }); continue; } throw error; }
      } finally { await rm(reservation, { force: true }); }
      await appendJsonl(this.tracePath, redactTrace({ at, event: 'skill.created', data: { name: draft.name, version, path: path.relative(this.runtimeRoot, target) } }));
      return { path: target, version, created: true };
    }
    throw new Error('skill version limit exceeded');
  }
  async proposePlugin(input: PluginProposal, at = new Date().toISOString()): Promise<PluginProposalResult> {
    if (!namePattern.test(input.name)) throw new Error('plugin proposal name must be lowercase kebab-case');
    if (!input.capabilityGap.trim() || !input.design.trim() || input.capabilityGap.length > 4000 || input.design.length > 16_384 || (input.tests?.length ?? 0) > 20 || (input.tests ?? []).some((item) => !item.trim() || item.length > 500)) throw new Error('plugin proposal fields exceed safe bounds');
    if (privacyPattern.test(`${input.capabilityGap}\n${input.design}\n${(input.tests ?? []).join('\n')}`)) throw new Error('plugin proposal must not contain personal facts or secrets');
    const directory = path.resolve(this.runtimeRoot, 'plugin-proposals'); await assertSafeDirectory(directory, this.runtimeRoot); await mkdir(directory, { recursive: true });
    for (let version = 1; version <= 1000; version++) {
      const target = path.join(directory, `${input.name}-v${version}.md`); const value = proposalText(input, version);
      try { if (await readFile(target, 'utf8') === value) return { path: target, version }; continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { await writeFile(target, value, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { continue; } throw error; }
      await appendJsonl(this.tracePath, redactTrace({ at, event: 'plugin.proposed', data: { name: input.name, version, path: path.relative(this.runtimeRoot, target), status: 'PROPOSED' } }));
      return { path: target, version };
    }
    throw new Error('plugin proposal version limit exceeded');
  }
}
