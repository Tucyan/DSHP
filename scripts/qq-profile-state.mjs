const marker = '# Personal Growth Agent QQ profile overlay';

export function buildQqProfileStates(prefix, enabledPatch) {
  if (typeof prefix !== 'string' || typeof enabledPatch !== 'string') throw new TypeError('QQ profile state inputs must be strings');
  const ids = enabledPatch.match(/^- id: im-qqbot$/gmu) ?? [];
  if (!enabledPatch.includes(marker) || ids.length !== 1 || (enabledPatch.match(/disabled:\s+(?:true|false)/g) ?? []).length !== 1) throw new Error('QQ profile renderer must produce exactly one managed row');
  if (!/^\s*disabled:\s+false\s*$/mu.test(enabledPatch)) throw new Error('QQ profile renderer must produce enabled state');
  const disabledPatch = enabledPatch.replace(/^(\s*disabled:\s+)false(\s*)$/mu, '$1true$2');
  if (disabledPatch === enabledPatch) throw new Error('QQ profile disabled transition failed');
  return { enabled: `${prefix}${enabledPatch}`, disabled: `${prefix}${disabledPatch}` };
}
