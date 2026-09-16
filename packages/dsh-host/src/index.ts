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
  SourceRef,
  PersonalGrowthBridgeOptions,
} from './bridge.js'
export * from './composition.js'
export * from './state.js'
export * from './activity.js'
export * from './activity-reader.js'
export * from './activity-tool.js'
export * from './skill-action.js'
export * from './activity.js'
export * from './activity-reader.js'
export { apply, inject, name } from './plugin.js'
