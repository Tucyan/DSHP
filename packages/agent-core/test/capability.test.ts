import { describe, expect, it } from 'vitest';
import { routeCapabilityGap } from '../src/capability.js';

describe('capability gap routing', () => {
  it('prefers a skill when existing tools can express the gap', () => {
    expect(routeCapabilityGap({ name: 'focus', gap: 'focus timer', canUseExistingTools: true, instructions: 'Use the timer tool.' })).toEqual({
      type: 'CREATE_SKILL', name: 'focus', instructions: 'Use the timer tool.',
    });
  });

  it('proposes a plugin when a gap needs a new capability', () => {
    expect(routeCapabilityGap({ name: 'calendar', gap: 'calendar access', canUseExistingTools: false, design: 'Add calendar API.' })).toEqual({
      type: 'PROPOSE_PLUGIN', name: 'calendar', capabilityGap: 'calendar access', design: 'Add calendar API.',
    });
  });
});
