/** Profile-layer wiring for the published Tencent bundle. */
export function buildTencentQqProfilePatch(peerId: string): string {
  if (!peerId || [...peerId].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('peerId contains control characters');
  if (peerId.includes('\\')) throw new Error('peerId contains unsafe YAML escape characters');
  const quotedPeer = JSON.stringify(peerId);
  return `# Personal Growth Agent QQ profile overlay
- id: im-qqbot
  name: '@tencent-connect/dsh-qqbot'
  disabled: false
  config:
    appId: __FROM_ENV__
    appSecret: __FROM_ENV__
    provider: deepseek-official
    model: deepseek-chat
    preset: personal-growth
    cwd: workspace
    groupPrompt: ''
    directPrompt: ''
    textChunkLimit: 4500
    sessionIdleTimeout: 1800000
    maxQueue: 20
    processingTimeoutMs: 120000
    historyLimit: 10
    access:
      c2cMode: allowlist
      c2cAllow: [${quotedPeer}]
      groupMode: disabled
      groupAllow: []
    requireMention: true
    debug: false
`;
}

export const TENCENT_QQ_ENV = Object.freeze({ appId: 'QQBOT_APPID', appSecret: 'QQBOT_SECRET' });
