/** Profile-layer wiring for the published Tencent bundle. */
export function buildTencentQqProfilePatch(peerId: string): string {
  if (!peerId || [...peerId].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('peerId contains control characters');
  const quotedPeer = JSON.stringify(peerId);
  return `# Personal Growth Agent QQ profile overlay
- insert:
    - id: im-qqbot
      name: '@tencent-connect/dsh-qqbot'
      config:
        appId: __FROM_ENV__
        appSecret: __FROM_ENV__
        # __FROM_ENV__ resolves from QQBOT_APPID and QQBOT_SECRET.
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
