export { MemoryManager } from './MemoryManager';
export { InMemoryStore } from './InMemoryStore';
export {
  InMemoryEpisodicStore,
  InMemoryEntityRegistry,
  InMemoryTemporalGraph,
  HighlightConcatenatingSummariser,
  createInMemoryLongHorizonMemory,
} from './LongHorizonMemory';
export type {
  Episode,
  EpisodeQuery,
  EpisodeSummariser,
  EpisodicMemoryStore,
  Entity,
  EntityRegistry,
  TemporalEdge,
  TemporalEdgeQuery,
  TemporalGraph,
  LongHorizonMemory,
} from './LongHorizonMemory';
export {
  InMemorySemanticGraph,
} from './SemanticMemoryGraph';
export type {
  SemanticMemoryGraph,
  MemoryEdge,
  MemoryEdgeKind,
  AddEdgeInput,
  EdgeQuery,
} from './SemanticMemoryGraph';
export { MemoryLifecycle } from './MemoryLifecycle';
export type {
  MutableMemoryStore,
  EmbedFn,
  DedupeOptions,
  PromoteOptions,
  DecayOptions,
  MemoryLifecycleOptions,
  DedupeResult,
  PromoteResult,
  DecayResult,
  ReconcileResult,
  LifecycleReport,
} from './MemoryLifecycle';
export {
  AllowAllAbsorptionGate,
  DenyAllAbsorptionGate,
  LLMAbsorptionGate,
  ApprovalAbsorptionGate,
  CompositeAbsorptionGate,
} from './AbsorptionGate';
export type {
  AbsorptionGate,
  AbsorptionCandidate,
  AbsorptionDecision,
  AbsorptionVerdict,
  JudgeScore,
  LLMAbsorptionGateOptions,
  ApprovalAbsorptionGateOptions,
  CompositeAbsorptionGateOptions,
} from './AbsorptionGate';
export { createMemoryTools } from './MemoryTools';
export type { CreateMemoryToolsOptions } from './MemoryTools';
export { HybridRetriever } from './HybridRetriever';
export type {
  RetrievalMode,
  HybridRetrievalOptions,
  ScoredMemory,
} from './HybridRetriever';
