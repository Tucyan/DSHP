// Keep the QQ-send observer factory package-internal. Consumers get the
// bridge's data/contracts, but cannot turn arbitrary DSH events into sends.
export { PersonalGrowthBridge, sessionIdForPeer } from './bridge.js'
export type {
  BridgeInbound,
  BridgeTarget,
  OutboundEnvelope,
  BridgeBot,
  BridgeAgentMessage,
  BridgeAgent,
  BridgeAgentRegistry,
  BridgeMemory,
  BridgeDream,
  MemoryTurnClaim,
  MemoryTurnInput,
  BridgeState,
  BridgeHeartbeat,
  BridgeSessionEvent,
  ConversationEvent,
  PersonalGrowthBridgeOptions,
} from './bridge.js'
export * from './composition.js'
export * from './state.js'
export * from './skill-action.js'
export { apply, inject, name } from './plugin.js'
