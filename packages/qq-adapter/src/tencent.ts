/**
 * Profile-layer wiring for the published Tencent bundle. The bundle itself owns
 * QQ protocol/authentication; this function only emits its documented config.
 */
export function buildTencentQqProfilePatch(peerId: string): string {
  if (!peerId || /[\r\n:[\]]/u.test(peerId)) throw new Error('peerId contains invalid patch characters');
  return `# Personal Growth Agent QQ profile overlay\n- insert:\n    - id: im-qqbot\n      name: '@tencent-connect/dsh-qqbot'\n      config:\n        appId: __FROM_ENV__\n        appSecret: __FROM_ENV__\n        access:\n          c2cMode: allowlist\n          c2cAllow: [${peerId}]\n          groupMode: disabled\n          groupAllow: []\n        requireMention: true\n        debug: false\n`;
}

export const TENCENT_QQ_ENV = Object.freeze({ appId: 'QQBOT_APPID', appSecret: 'QQBOT_SECRET' });
