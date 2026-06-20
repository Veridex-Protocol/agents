/**
 * @packageDocumentation
 * @module @veridex/agents
 * @description
 * Veridex Agent Fabric — a model-agnostic, payment-native agent runtime.
 *
 * @example
 * ```ts
 * import { createAgent, tool, OpenAIProvider } from '@veridex/agents';
 * import { z } from 'zod';
 *
 * const agent = createAgent({
 *   id: 'my-agent',
 *   name: 'My Agent',
 *   model: { provider: 'openai', model: 'gpt-4o' },
 *   instructions: 'You are a helpful assistant.',
 *   tools: [
 *     tool({
 *       name: 'greet',
 *       description: 'Greet a user',
 *       input: z.object({ name: z.string() }),
 *       safetyClass: 'read',
 *       async execute({ input }) {
 *         return { llmOutput: `Hello, ${input.name}!`, success: true };
 *       },
 *     }),
 *   ],
 * });
 *
 * const result = await agent.run('Say hello to Alice');
 * console.log(result.output);
 * ```
 */

// ── Core Runtime ──
export { AgentRuntime } from './runtime/AgentRuntime';
export { createAgent } from './runtime/createAgent';
export { buildRuntimeBootstrapReport } from './runtime/bootstrap';
export {
  NoopLLMResponseGuard,
  NoopSupplyChainGuard,
  generateCanaryToken,
} from './runtime/guards';
export type {
  LLMResponseGuard,
  SupplyChainGuard,
  GuardToolCallProposal,
  GuardViolation,
  LLMResponseValidation,
  SupplyChainCheck,
  SupplyChainIssue,
} from './runtime/guards';
export type { RuntimePlugin, RuntimePluginContext } from './runtime/RuntimePlugin';

// ── Agent Registry Bridge ──
export { AgentRegistryBridge } from './registry/AgentRegistryBridge';
export type { AgentRegistryConfig, RegistryAgentRecord } from './registry/AgentRegistryBridge';

// ── Types ──
export type {
  // Agent
  AgentDefinition,
  PaymentConfig,
  PolicyConfig,
  HandoffExecutionContext,
  HandoffExecutionResult,
  HandoffHandler,
  RuntimeOptions,
  // Runtime
  Run,
  RunState,
  Turn,
  TurnStopReason,
  TurnOutcome,
  TurnResult,
  RunResult,
  RunSessionSnapshot,
  RoutedCapabilityMatch,
  ApprovalStateSnapshot,
  ContextPlanSummary,
  ResumeRunOptions,
  RunCheckpointState,
  // Tools
  ToolContract,
  ToolResult,
  ToolSafetyClass,
  ToolCall,
  ToolExecuteParams,
  ToolContext,
  ToolAttachment,
  ToolMetrics,
  CostEstimate,
  ToolDescriptionGuidance,
  ToolErrorTemplates,
  // Execution
  CapabilitySource,
  ExecutionCapabilityKind,
  ExecutableCapability,
  ExecutionSurfaceSummary,
  // Memory
  MemoryTier,
  MemoryEntry,
  MemoryEntryKind,
  MemoryStore,
  MemoryQuery,
  MemoryWriteRequest,
  MemoryConfig,
  MemoryStateAuthority,
  MemoryStateReference,
  MemoryEvidenceReference,
  MemoryDerivation,
  MemoryProvenance,
  MemoryScope,
  TierConfig,
  CompactOptions,
  CompactResult,
  // Transcript
  TranscriptEntryKind,
  TranscriptEntry,
  TranscriptReplayOptions,
  TranscriptRef,
  TranscriptStore,
  TranscriptStoreMode,
  // Context
  ContextSection,
  ContextSource,
  ContextPlan,
  ContextCompilerOptions,
  ContextSectionInput,
  ContextRetrievalPolicy,
  ContextSourceConfig,
  TruncationStrategy,
  // Hooks
  HookPhase,
  RuntimeHook,
  HookResult,
  HookOverride,
  HookManifest,
  HookPermission,
  RunHookContext,
  TurnHookContext,
  ToolHookContext,
  ErrorHookContext,
  // Events
  TraceEventType,
  TraceEvent,
  BootstrapReportGeneratedEvent,
  TokenStreamedEvent,
  // Models
  ModelConfig,
  ModelProvider,
  ModelMessage,
  ModelResponse,
  ModelUsage,
  ModelCompletionOptions,
  ModelToolDefinition,
  // Proposals
  ActionProposal,
  FinalAnswerProposal,
  ToolCallProposal,
  MemoryWriteProposal,
  HandoffProposal,
  ApprovalRequestProposal,
  // Policy
  PolicyVerdict,
  PolicyDecision,
  PolicyCheckResult,
  // Bootstrap
  TransportKind,
  TransportAvailability,
  CapabilitySourceCount,
  RuntimeBootstrapReport,
  // Accountability
  IdempotencyKey,
  ExecutionPhase,
  ExecutionNodeKind,
  ExecutionNodeStatus,
  ExecutionEdgeRelation,
  ToolExecutionOutcome,
  ActorRef,
  ResourceRef,
  SideEffectReceipt,
  ExecutionNode,
  ExecutionEdge,
  ExecutionGraph,
  ExecutionGraphRef,
  StoredRunRecord,
  ThreadRecord,
  RunStore,
  ThreadStore,
  ExecutionGraphStore,
  MemoryRecordKind,
  EvidenceRef,
  MemoryProposal,
  MemoryValidationIssueCode,
  MemoryValidationIssue,
  MemoryProposalValidationResult,
  MemoryProposalValidator,
  BrowserSessionRef,
  BrowserArtifactRef,
  BrowserCapabilityMetadata,
  // Identity
  AgentIdentityClaims,
  AgentIntegrityBinding,
  ResponseEnvelope,
  PolicyEnvelopeEntry,
} from './types';

// ── Events ──
export { EventBus } from './events/EventBus';
export { EventLog } from './events/EventLog';

// ── Models ──
export { OpenAIProvider } from './models/OpenAIProvider';
export type { OpenAIProviderConfig } from './models/OpenAIProvider';
export { AnthropicProvider } from './models/AnthropicProvider';
export type { AnthropicProviderConfig } from './models/AnthropicProvider';
export { GeminiProvider } from './models/GeminiProvider';
export type { GeminiProviderConfig } from './models/GeminiProvider';
export { ModelRegistry } from './models/ModelRegistry';
export { OpenAICompatibleProvider } from './models/OpenAICompatibleProvider';
export type { OpenAICompatibleConfig } from './models/OpenAICompatibleProvider';
export { XAIProvider } from './models/XAIProvider';
export type { XAIProviderConfig } from './models/XAIProvider';
export { DeepSeekProvider } from './models/DeepSeekProvider';
export type { DeepSeekProviderConfig } from './models/DeepSeekProvider';
export { ZhipuProvider } from './models/ZhipuProvider';
export type { ZhipuProviderConfig } from './models/ZhipuProvider';
export { QwenProvider } from './models/QwenProvider';
export type { QwenProviderConfig } from './models/QwenProvider';
export { MoonshotProvider } from './models/MoonshotProvider';
export type { MoonshotProviderConfig } from './models/MoonshotProvider';
export { OllamaProvider } from './models/OllamaProvider';
export type { OllamaProviderConfig } from './models/OllamaProvider';

// ── Integrity ──
export {
  canonicalJSON,
  sha256,
  hashAgentDefinition,
  hashToolManifest,
  computeAgentChecksum,
  buildIntegrityBinding,
  buildResponseEnvelope,
  verifyResponseEnvelope,
} from './models/integrity';
export type { ResponseEnvelopeParams } from './models/integrity';

// ── Tools ──
export { ToolRegistry } from './tools/ToolRegistry';
export { ToolExecutor } from './tools/ToolExecutor';
export type { ToolExecutionResult } from './tools/ToolExecutor';
export { ToolValidator } from './tools/ToolValidator';
export {
  tool,
  compileToolDescription,
  formatToolError,
  lintToolContract,
} from './tools/tool';
export type { ToolOptions, ToolLintIssue } from './tools/tool';
export { createPlanningTools } from './tools/PlanningTools';
export type { PlanningToolsOptions, TodoEntry } from './tools/PlanningTools';
export { createFilesystemTools } from './tools/FilesystemTools';
export type { FilesystemToolsOptions } from './tools/FilesystemTools';
export { createSubagentTools } from './tools/SubagentTools';
export type { SubagentToolsOptions, SubagentEntry, SubagentExecutor } from './tools/SubagentTools';
export { ExecutionSurfaceRegistry } from './execution';
export {
  DenyAllSandbox,
  LocalProcessSandbox,
  createSandboxedExecTool,
} from './execution/Sandbox';
export type {
  SandboxRuntime,
  SandboxCapabilities,
  SandboxLanguage,
  SandboxExecuteRequest,
  SandboxExecuteResult,
  SandboxNetworkPolicy,
  LocalProcessSandboxOptions,
  SandboxedExecToolOptions,
} from './execution/Sandbox';

// ── Hooks ──
export { HookRegistry } from './hooks/HookRegistry';
export { HookRunner } from './hooks/HookRunner';
export type { HookRunResult } from './hooks/HookRunner';

// ── Context ──
export { ContextCompiler } from './context/ContextCompiler';
export { DEFAULT_RETRIEVAL_POLICY } from './context/ContextCompiler';
export {
  LinearFidelityModel,
  MODEL_DEGRADATION,
  degradationFor,
  registerModelDegradation,
  resolveFidelityModel,
} from './context/FidelityModel';
export type { FidelityModel } from './context/FidelityModel';
export { HomeostaticContextEngine } from './context/HomeostaticContextEngine';
export type {
  CompactionReason,
  CompactionTrigger,
  FidelityReport,
  HomeostaticContextEngineOptions,
  HomeostaticContextPlan,
} from './context/HomeostaticContextEngine';
export {
  DeterministicCompactor,
  LLMRewriteCompactor,
  DEFAULT_PROTECTED_SOURCES,
} from './context/Compactor';
export type {
  Compactor,
  CompactionAction,
  CompactionActionKind,
  CompactionRequest,
  CompactionResult,
  SummariseFn,
} from './context/Compactor';

// ── Memory ──
export { MemoryManager } from './memory/MemoryManager';
export { InMemoryStore } from './memory/InMemoryStore';
export {
  InMemoryEpisodicStore,
  InMemoryEntityRegistry,
  InMemoryTemporalGraph,
  HighlightConcatenatingSummariser,
  createInMemoryLongHorizonMemory,
} from './memory/LongHorizonMemory';
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
} from './memory/LongHorizonMemory';
export { InMemorySemanticGraph } from './memory/SemanticMemoryGraph';
export type {
  SemanticMemoryGraph,
  MemoryEdge,
  MemoryEdgeKind,
  AddEdgeInput,
  EdgeQuery,
} from './memory/SemanticMemoryGraph';
export { MemoryLifecycle } from './memory/MemoryLifecycle';
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
} from './memory/MemoryLifecycle';
export { createMemoryTools } from './memory/MemoryTools';
export type { CreateMemoryToolsOptions } from './memory/MemoryTools';
export { HybridRetriever } from './memory/HybridRetriever';
export type {
  RetrievalMode,
  HybridRetrievalOptions,
  ScoredMemory,
} from './memory/HybridRetriever';
export { InMemoryTranscriptStore, FileTranscriptStore } from './transcript';
export {
  InMemoryRunStore,
  FileRunStore,
  InMemoryThreadStore,
  FileThreadStore,
  InMemoryExecutionGraphStore,
  FileExecutionGraphStore,
} from './accountability';

// ── Checkpoints ──
export { CheckpointManager, InMemoryCheckpointStore } from './checkpoints/CheckpointManager';
export type { Checkpoint, CheckpointStore } from './checkpoints/CheckpointManager';

// ── Postgres Stores ──
export {
  createPostgresStores,
  PostgresRunStore,
  PostgresThreadStore,
  PostgresExecutionGraphStore,
  PostgresMemoryStore,
  PostgresTranscriptStore,
  PostgresCheckpointStore,
} from './stores';
export type {
  PostgresQueryExecutor,
  PostgresStoreConfig,
  PostgresStores,
} from './stores';

// ── Integrations ──
export { CoreAdapter } from './integrations/CoreAdapter';
export type { CoreAdapterConfig } from './integrations/CoreAdapter';
export { PaymentsAdapter } from './integrations/PaymentsAdapter';
export type { PaymentsAdapterConfig } from './integrations/PaymentsAdapter';
export { paymentsGuardsPlugin } from './integrations/PaymentsGuardsPlugin';
export type { PaymentsGuardsPluginOptions } from './integrations/PaymentsGuardsPlugin';
export { securityGatewayPlugin } from './integrations/SecurityGatewayPlugin';
export type { SecurityGatewayPluginOptions } from './integrations/SecurityGatewayPlugin';
export { WorkspaceStateAdapter } from './integrations/WorkspaceStateAdapter';
export type {
  WorkspaceStateProvider,
  WorkspaceResourceSnapshot,
  EvidenceSnapshot,
  WorkspaceStateQuery,
  EvidenceQuery,
  WorkspaceStateMutation,
  WorkspaceStateMutationResult,
} from './integrations/WorkspaceStateAdapter';

// ── Policy ──
export { PolicyEngine, blockSafetyClasses, requireApprovalFor, maxRunSpendUSD, maxTokenBudget, allowChains, requireVerifiedEnvelope } from './policy';
export { buildUnifiedPolicyContext, resolveConstraints, isDelegationAllowed, ENFORCEMENT_PRIORITY } from './policy';
export type { PolicyRule, PolicyContext } from './policy';
export type {
  EnforcementLevel,
  LeveledConstraint,
  DelegationEntry,
  TransportPolicyContext,
  UnifiedPolicyContext,
} from './policy';

// ── Intent Verification ──
export { KeywordFilter, NLIVerifier, BenignOverride, IntentVerifier, DEFAULT_FINANCIAL_BLOCKLIST } from './intent';
export type {
  IntentCheckResult,
  IntentVerdict,
  IntentContext,
  KeywordFilterConfig,
  NLIBackend,
  NLIVerifierConfig,
  BenignOverrideConfig,
  IntentVerifierConfig,
} from './intent';

// ── Credentials ──
export { buildMandateCredential, verifyMandateCredential, RevocationRegistry } from './credentials';
export {
  DelegationGuard,
  HmacMandateSigner,
  attenuateMandate,
  signMandate,
  verifyMandateSignature,
  canonicalMandatePayload,
  DelegationError,
} from './credentials';
export type {
  VCProof,
  VerifiableCredential,
  CredentialStatus,
  MandateSpendingLimit,
  MandateActionConstraint,
  MandateDelegation,
  MandateCredentialSubject,
  MandateCredential,
  BuildMandateParams,
  MandateVerificationResult,
  MandateSigner,
  MandateVerifier,
  AttenuateMandateParams,
  DelegationGuardOptions,
  DelegationRequest,
  DelegationDecision,
} from './credentials';

// ── Recovery (VA-DAR) ──
export { VADARKeySchedule, InMemoryArtifactStore, DeRecBridge, hkdfDerive, bytesToHex, hexToBytes, encryptArtifact, decryptArtifact, hmacSHA256 } from './recovery';
export type {
  DerivedKey,
  KeyScheduleConfig,
  RecoveryArtifact,
  ArtifactStoreBackend,
  DeRecShare,
  DeRecHelper,
} from './recovery';

// ── Advanced (Phase 4) ──
export { MockTEEAttestor, MockZKComplianceProver, SBTReputationTracker, activateEnvelope, DEFAULT_ENVELOPE_ACTIVATION } from './advanced';
export type {
  TEEPlatform,
  TEEAttestation,
  TEEVerificationResult,
  TEEAttestor,
  ZKProofSystem,
  ZKComplianceProof,
  ZKComplianceClaimType,
  ZKComplianceClaim,
  ZKVerificationResult,
  ZKComplianceProver,
  ReputationDimension,
  ReputationScore,
  SBTReputation,
  ReputationUpdate,
  EnvelopeActivationConfig,
  EnvelopeActivationResult,
} from './advanced';

// ── Approvals ──
export { ApprovalManager } from './approvals';
export type { ApprovalMode, ApprovalRequest, ApprovalDecision, ApprovalHandler, ApprovalRoute } from './approvals';

// ── Audit ──
export { AuditEmitter, InMemoryAuditSink } from './audit';
export { TraceEnvelopeBuilder, UnifiedTraceCollector, InMemoryEnvelopeSink } from './audit';
export type { AuditBundle, ToolExecutionSummary, AuditExportFormat, AuditSink } from './audit';
export type {
  TraceEnvelope,
  TraceEnvelopeBuildParams,
  ReasoningSnapshot,
  EnvelopeStorageReceipt,
  EnvelopeSettlementProof,
  EnvelopeVerificationResult,
  EnvelopeSink,
  UnifiedTraceCollectorOptions,
} from './audit';

// ── Testing ──
export { ReplayProvider, TraceRecorder, compareTraces, serializeGoldenTrace, deserializeGoldenTrace } from './testing';
export type { RecordedInteraction, GoldenTrace, TraceComparisonResult, EventDiff } from './testing';

// ── Streaming ──
export { eventToSSE, streamToSSE, streamTokens } from './streaming';

// ── Transports ──
export { MCPServerTransport, ACPTransport, A2ATransport } from './transports';
export { RetryExecutor, CircuitBreaker, TransportPolicyEvaluator, RemoteCallTracer, CapabilityManifestRegistry } from './transports';
export { TransportBoundaryPEP } from './transports';
export { DEFAULT_RETRY_POLICY, DEFAULT_TIMEOUT_POLICY, DEFAULT_CIRCUIT_BREAKER_CONFIG } from './transports';
export type {
  Transport,
  TransportState,
  MCPToolDefinition,
  MCPToolCall,
  MCPToolResponse,
  ACPCapability,
  ACPTaskRequest,
  ACPTaskResponse,
  ACPTransportConfig,
  TransportAuthConfig,
  TransportRequestOptions,
  A2AAgentCard,
  A2ATask,
  A2ATaskResult,
  A2ATransportConfig,
  // Transport Hardening
  RetryPolicy,
  TimeoutPolicy,
  CircuitBreakerState,
  CircuitBreakerConfig,
  TransportEndpointPolicy,
  TransportPolicy,
  CapabilityManifest,
  RemoteCallOutcome,
  RemoteCallRecord,
  PolicyEvaluationResult,
  RetryExecutorOptions,
  RetryResult,
  CircuitBreakerSnapshot,
  TransportPolicyEvaluatorOptions,
  RemoteCallTracerOptions,
  StartCallParams,
  FinishCallParams,
  // Transport Boundary PEP
  BoundaryPEPResult,
  BoundaryPEPConfig,
} from './transports';

// ── Orchestration ──
export { TaskGraph, Scheduler, Orchestrator } from './orchestration';
export type {
  OrchestrationTask,
  OrchestrationTaskStatus,
  OrchestrationTaskPriority,
  CreateOrchestrationTaskOptions,
  TaskGraphResult,
  TeamMember,
  TeamConfig,
  SchedulerStrategy,
  SchedulerConfig,
  OrchestratorEvent,
  OrchestratorConfig,
  OrchestratorResult,
  AgentExecutor,
} from './orchestration';

// ── Security ──
export { SecurityPolicyPackManager } from './security';
export {
  injectionDetectionPack,
  toolPoisoningPack,
  handoffSafetyPack,
  modelRestrictionPack,
  budgetCeilingPack,
  endpointAllowlistPack,
} from './security';
export type {
  SecurityPolicyPack,
  SecurityPackManagerOptions,
  InjectionDetectionPackOptions,
  ToolPoisoningPackOptions,
  HandoffSafetyPackOptions,
  ModelRestrictionPackOptions,
  BudgetCeilingPackOptions,
  EndpointAllowlistPackOptions,
} from './security';

// ── Evals ──
export {
  runScenario,
  runEvalSuite,
  runPolicyScenarioWithRules,
  runSplit,
  validateSplitBalance,
  toCaseOutcome,
  buildSplitResult,
} from './evals';
export {
  policyPassthroughScenario,
  policyFinalAnswerPassScenario,
  contextNoBudgetPressureScenario,
  contextTruncationScenario,
  contextPriorityOrderingScenario,
  circuitBreakerStaysClosedScenario,
  circuitBreakerOpensScenario,
  circuitBreakerResetOnSuccessScenario,
  memoryWriteSearchScenario,
  memoryEmptyBaselineScenario,
  injectionDetectionScenario,
  injectionCleanPassScenario,
  budgetCeilingBlockScenario,
  handoffAllowedScenario,
  handoffBlockedScenario,
  handoffAllowlistScenario,
  allBuiltInScenarios,
} from './evals';
export type {
  ScenarioStatus,
  ScenarioCategory,
  BaseScenario,
  PolicyScenario,
  EvalContextSection,
  ContextScenario,
  TransportScenario,
  MemoryScenario,
  SecurityScenario,
  HandoffScenario,
  EvalScenario,
  ScenarioResult,
  AssertionResult,
  EvalSuiteResult,
  EvalSplit,
  CaseOutcome,
  SplitResult,
  StrataValidation,
  ScenarioOverrides,
} from './evals';

// Surfaces
export type {
  HarnessSurfaceKind,
  HarnessSurface,
  HarnessVariant,
  VariantDiff,
} from './evals';
export {
  extractSurfaces,
  buildVariant,
  buildVariantFromDef,
  applyVariant,
  diffVariants,
} from './evals';

// Experiment
export type {
  AcceptanceCriteria,
  ExperimentConfig,
  IterationDiagnosis,
  IterationRecord,
  ExperimentReport,
} from './evals';
export { runExperiment } from './evals';

// Skills (Phase 4) — first-class Skill primitive with progressive
// disclosure, resolver, audits, packs, and the skillify lifecycle.
export * from './skills';

// ── Phase 5: harness UX (deploy, ralph loop, observability) ──
// Model router — declarative task-aware model selection.
export * from './routing';
// Sandbox lifecycle — per-session sandbox pool with snapshot/restore.
export {
  InMemorySandboxLifecycleManager,
} from './execution';
export type {
  SandboxLifecycleManager,
  SandboxFactory,
  SandboxSnapshot,
  InMemoryLifecycleOptions,
} from './execution';
// Deploy bundler + CLI.
export * from './deploy';
// Stateful evaluation harness — already surfaced via `export * from './evals'`
// indirection above, but we re-export the new symbols explicitly so
// downstream tooling can discover them via auto-import.
export {
  diffMemorySnapshots,
  RubricStateJudge,
  runStatefulScenarios,
  compareTrajectories,
  gateRegressions,
} from './evals/stateful';
export type {
  MemoryEntrySnapshot,
  MemorySnapshot as StatefulMemorySnapshot,
  MemoryDiff,
  TrajectoryTurnSnapshot,
  StatefulTrajectory,
  StateRubricCriterion,
  JudgeResult as StateJudgeResult,
  StateJudge,
  StatefulScenarioRun,
  StatefulRunReport,
  StatefulScenarioInput,
  StatefulRunnerOptions,
  RegressionEntry,
  RegressionReport,
} from './evals/stateful';
