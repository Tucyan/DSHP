import { AdminError } from './files.js'

const MODEL_NAMESPACE = 'agent-default-model'

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelSettingsView {
  selection: ModelSelection
  revision: number
  configPath: string | null
  applies: 'live' | 'restart'
}

export interface ModelSettingsPort {
  view(): ModelSettingsView
  update(selection: ModelSelection, expectedRevision: number): Promise<ModelSettingsView>
}

interface ModelSettingsContext {
  agentDefaultModel?: { currentSelection?: () => ModelSelection | undefined }
  settings?: {
    documentPath?: string
    describe(options: { redactSecrets: true }): Array<{ ns: string; revision: number; applies: string }>
    replace(namespace: string, section: object, expectedRevision?: number): Promise<void>
  }
}

function selectionOf(ctx: ModelSettingsContext): ModelSelection {
  const selection = ctx.agentDefaultModel?.currentSelection?.()
  if (!selection?.provider || !selection.model) throw new Error('model settings require a public DSH default model selection')
  return { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}) }
}

export function createDshModelSettings(ctx: ModelSettingsContext, afterUpdate: (selection: ModelSelection) => Promise<void> | void = () => undefined): ModelSettingsPort {
  const settings = ctx.settings
  if (!settings?.describe || !settings.replace) throw new Error('model settings require a writable DSH settings service')
  const view = (): ModelSettingsView => {
    const descriptor = settings.describe({ redactSecrets: true }).find(item => String(item.ns) === MODEL_NAMESPACE)
    if (!descriptor) throw new Error(`model settings namespace "${MODEL_NAMESPACE}" is unavailable`)
    return {
      selection: selectionOf(ctx),
      revision: descriptor.revision,
      configPath: settings.documentPath ?? null,
      applies: descriptor.applies === 'restart' ? 'restart' : 'live',
    }
  }
  return {
    view,
    async update(selection, expectedRevision) {
      try {
        await settings.replace(MODEL_NAMESPACE, selection, expectedRevision)
      } catch (error) {
        if ((error as { code?: unknown }).code === 'SETTINGS_CONFLICT') throw new AdminError(409, 'model_conflict')
        throw error
      }
      const updated = view()
      await afterUpdate(updated.selection)
      return updated
    },
  }
}
