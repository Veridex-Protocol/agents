export { ContextCompiler, DEFAULT_RETRIEVAL_POLICY } from './ContextCompiler';
export {
  LinearFidelityModel,
  MODEL_DEGRADATION,
  degradationFor,
  registerModelDegradation,
  resolveFidelityModel,
  applyEncodingDiscount,
  type FidelityModel,
  type EncodingHint,
} from './FidelityModel';
export {
  LRUEncodingTracker,
  defaultChunker,
  type EncodingTracker,
  type EncodingState,
  type EncodingChunk,
  type EncodingClassification,
  type ClassifyOptions,
  type RecordOptions,
  type LRUEncodingTrackerOptions,
  type SerializedEncodingState,
} from './EncodingState';
export {
  HomeostaticContextEngine,
  type CompactionReason,
  type CompactionTrigger,
  type FidelityReport,
  type HomeostaticContextEngineOptions,
  type HomeostaticContextPlan,
} from './HomeostaticContextEngine';
export {
  DeterministicCompactor,
  LLMRewriteCompactor,
  DEFAULT_PROTECTED_SOURCES,
  type Compactor,
  type CompactionAction,
  type CompactionActionKind,
  type CompactionRequest,
  type CompactionResult,
  type SummariseFn,
} from './Compactor';
