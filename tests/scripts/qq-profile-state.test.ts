import { describe, expect, it } from 'vitest';
import { buildQqProfileStates } from '../../scripts/qq-profile-state.mjs';

describe('managed QQ profile state', () => {
  it('renders a disabled transaction state while preserving the fixed peer', () => {
    const enabled = '# Personal Growth Agent QQ profile overlay\n- id: im-qqbot\n  disabled: false\n  config:\n    access:\n      c2cAllow: ["123"]\n';
    const states = buildQqProfileStates('', enabled);
    expect(states.enabled).toContain('disabled: false');
    expect(states.disabled).toContain('disabled: true');
    expect(states.disabled).toContain('c2cAllow: ["123"]');
    expect(states.disabled).not.toContain('disabled: false');
  });
  it('rejects a renderer result without exactly one managed row', () => {
    expect(() => buildQqProfileStates('', '- id: im-qqbot\n  disabled: false\n- id: im-qqbot\n  disabled: false\n')).toThrow(/exactly one/i);
  });
});
