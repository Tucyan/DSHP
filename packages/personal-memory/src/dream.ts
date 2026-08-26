import { ProposalSchema, type MemoryProposal } from './proposal.js';

export interface DreamInput { newHistory: readonly unknown[]; profile: string; index: string; relevantMemories: readonly string[]; }
export interface ProposalModelPort { propose?(input: DreamInput): unknown | Promise<unknown>; generateProposals?(input: DreamInput): unknown | Promise<unknown>; generate?(input: DreamInput): unknown | Promise<unknown>; }

/** Pure proposal generation. It has no workspace or filesystem capability. */
export class DreamService {
  private readonly model: ProposalModelPort;
  constructor(model: ProposalModelPort | { model: ProposalModelPort }) { this.model = 'model' in model ? model.model : model; }
  async dream(input: DreamInput): Promise<MemoryProposal[]> {
    const generate = this.model.propose ?? this.model.generateProposals ?? this.model.generate;
    if (!generate) throw new Error('Dream proposal model is not configured');
    const generated = await generate.call(this.model, input);
    if (!Array.isArray(generated)) throw new Error('Dream model must return an array of proposals');
    return generated.map((proposal) => ProposalSchema.parse(proposal));
  }
  async propose(input: DreamInput): Promise<MemoryProposal[]> { return this.dream(input); }
}
