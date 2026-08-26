import { describe, expect, it } from 'vitest';
import { ConfigSchema, parseConfig } from '../src/config.js';

describe('config schema', () => {
  it('accepts a workspace and defaults timezone', () => {
    expect(parseConfig({ workspaceDir: '/tmp/personal-agent' })).toMatchObject({
      workspaceDir: '/tmp/personal-agent',
      timezone: 'UTC',
    });
  });

  it('rejects an empty workspace', () => {
    expect(ConfigSchema.safeParse({ workspaceDir: '' }).success).toBe(false);
  });
});
