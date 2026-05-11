export {
  KeywordFilter,
  NLIVerifier,
  BenignOverride,
  IntentVerifier,
  DEFAULT_FINANCIAL_BLOCKLIST,
} from './IntentVerification';
export type {
  IntentCheckResult,
  IntentVerdict,
  IntentContext,
  KeywordFilterConfig,
  NLIBackend,
  NLIVerifierConfig,
  BenignOverrideConfig,
  IntentVerifierConfig,
} from './IntentVerification';

// ── Pluggable NLI backends (no-training-required providers) ──
export {
  KeywordOverlapNLIBackend,
  EmbeddingSimilarityNLIBackend,
  LLMJudgeNLIBackend,
  CompositeNLIBackend,
} from './NLIBackends';
export type {
  KeywordOverlapConfig,
  EmbeddingSimilarityConfig,
  EmbedFn,
  LLMJudgeConfig,
  ChatCompletionFn,
  CompositeConfig,
  CompositeStrategy,
} from './NLIBackends';
