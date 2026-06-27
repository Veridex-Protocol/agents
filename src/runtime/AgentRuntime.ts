/**
 * @packageDocumentation
 * @module AgentRuntime
 * @description
 * The core agent runtime — the main orchestration loop.
 * Assembles context, calls the model, parses proposals, executes tools,
 * runs hooks, manages memory, and emits trace events.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AgentDefinition,
  RuntimeOptions,
  HandoffHandler,
} from '../types/agent';
import type {
  Run,
  RunState,
  Turn,
  RunResult,
  ResumeRunOptions,
  RunCheckpointState,
  TurnOutcome,
  TurnStopReason,
  ApprovalStateSnapshot,
  ContextPlanSummary,
  RoutedCapabilityMatch,
  RunSessionSnapshot,
} from '../types/runtime';
import type {
  ActionProposal,
  ToolCallProposal,
  MemoryWriteProposal,
  HandoffProposal,
  ApprovalRequestProposal,
} from '../types/proposals';
import type {
  ModelMessage,
  ModelResponse,
  ModelProvider,
  ModelToolDefinition,
} from '../types/models';
import type { ToolCall, ToolContract } from '../types/tools';
import type { TraceEvent } from '../types/events';
import type { ContextPlan, ContextSectionInput, ContextRetrievalPolicy } from '../types/context';
import type { MemoryEntry, MemoryWriteRequest } from '../types/memory';
import type { ExecutableCapability } from '../types/execution';
import type { TranscriptEntry } from '../types/transcript';
import type { RuntimeBootstrapReport } from '../types/bootstrap';
import type {
  ActorRef,
  ExecutionGraphStore,
  ExecutionNode,
  IdempotencyKey,
  MemoryProposal,
  MemoryProposalValidationResult,
  MemoryProposalValidator,
  ResourceRef,
  RunStore,
  SideEffectReceipt,
  StoredRunRecord,
  ThreadRecord,
  ThreadStore,
  ToolExecutionOutcome,
} from '../types/accountability';

import { EventBus } from '../events/EventBus';
import { EventLog } from '../events/EventLog';
import { ModelRegistry } from '../models/ModelRegistry';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolExecutor } from '../tools/ToolExecutor';
import { ToolValidator } from '../tools/ToolValidator';
import type { ToolExecutionResult } from '../tools/ToolExecutor';
import { HookRegistry } from '../hooks/HookRegistry';
import { HookRunner } from '../hooks/HookRunner';
import { ContextCompiler } from '../context/ContextCompiler';
import { DEFAULT_RETRIEVAL_POLICY } from '../context/ContextCompiler';
import {
  HomeostaticContextEngine,
  type CompactionTrigger,
  type FidelityReport,
  type HomeostaticContextEngineOptions,
} from '../context/HomeostaticContextEngine';
import type { Compactor } from '../context/Compactor';
import {
  createLoadToolBuiltin,
  renderDisclosedCatalog,
} from '../tools/ToolDisclosureTools';
import { MemoryManager } from '../memory/MemoryManager';
import { CheckpointManager } from '../checkpoints/CheckpointManager';
import { InMemoryTranscriptStore } from '../transcript';
import {
  InMemoryExecutionGraphStore,
  InMemoryRunStore,
  InMemoryThreadStore,
} from '../accountability';
import { CoreAdapter } from '../integrations/CoreAdapter';
import { PaymentsAdapter } from '../integrations/PaymentsAdapter';
import { WorkspaceStateAdapter } from '../integrations/WorkspaceStateAdapter';
import { PolicyEngine } from '../policy';
import { ApprovalManager } from '../approvals';
import { AuditEmitter } from '../audit';
import { ExecutionSurfaceRegistry } from '../execution';
import { buildRuntimeBootstrapReport } from './bootstrap';
import type { CheckpointStore } from '../checkpoints/CheckpointManager';
import type { MemoryStore } from '../types/memory';
import type { PolicyRule, PolicyDecision } from '../policy';
import type { ApprovalRoute, ApprovalDecision, ApprovalHandler, ApprovalMode } from '../approvals';
import type { AuditSink, ToolExecutionSummary } from '../audit';
import type { HookPhase } from '../types/hooks';
import type { HookRunResult } from '../hooks/HookRunner';
import type { TranscriptStore } from '../types/transcript';
import type { AgentIdentityClaims, AgentIntegrityBinding, ResponseEnvelope } from '../types/identity';
import { buildIntegrityBinding, buildResponseEnvelope } from '../models/integrity';
import type { IntentVerifier, } from '../intent/IntentVerification';
import {
  type LLMResponseGuard,
  type SupplyChainGuard,
  type GuardToolCallProposal,
  NoopLLMResponseGuard,
  NoopSupplyChainGuard,
  generateCanaryToken,
} from './guards';
import type { RuntimePlugin, RuntimePluginContext } from './RuntimePlugin';
import { AgentRegistryBridge } from '../registry/AgentRegistryBridge';
import type { AgentRegistryConfig } from '../registry/AgentRegistryBridge';
import {
  SecurityPolicyPackManager,
  injectionDetectionPack,
  toolPoisoningPack,
  handoffSafetyPack,
  modelRestrictionPack,
  budgetCeilingPack,
  endpointAllowlistPack,
  shellInstallGatePack,
  requestSecretRedactionPack,
  intentVerificationPack,
  responseHashLoggingPack,
  persistentTransparencyLogPack,
  crossTurnAnomalyPack,
  canaryCredentialPack,
  tlsCertPinningPack,
} from '../security';
import type { CanaryCredentialDeployer } from '../security/CanaryCredentialDeployer';

/** Generate a unique event ID. */
function eventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cloneRun(run: Run): Run {
  return JSON.parse(JSON.stringify(run)) as Run;
}

const DEFAULT_CONTEXT_TOKEN_BUDGET = 4000;
const DEFAULT_HISTORY_TURNS = 6;

type ProposalExecutionOptions = {
  approval?: ResumeRunOptions['approval'];
};

type ProposalControlResult = {
  blocked?: boolean;
  terminalState?: RunState;
  waitingForApproval?: boolean;
  requestId?: string;
  reasons?: string[];
  approvalMode?: ApprovalStateSnapshot['mode'];
  estimatedSpendUSD?: number;
  output?: string;
  metadata?: Record<string, unknown>;
  policyDecision?: PolicyDecision;
  approvalDecision?: ApprovalDecision;
  toolExecutionSummaries?: ToolExecutionSummary[];
};

export class AgentRuntime {
  readonly definition: AgentDefinition;

  // Sub-systems
  readonly events: EventBus;
  readonly eventLog: EventLog;
  readonly models: ModelRegistry;
  readonly tools: ToolRegistry;
  readonly toolValidator: ToolValidator;
  readonly toolExecutor: ToolExecutor;
  readonly hooks: HookRegistry;
  readonly hookRunner: HookRunner;
  readonly context: ContextCompiler;
  readonly memory: MemoryManager;
  readonly checkpoints: CheckpointManager;
  readonly transcripts: TranscriptStore;
  readonly executionSurface: ExecutionSurfaceRegistry;
  readonly runStore: RunStore;
  readonly threadStore: ThreadStore;
  readonly executionGraphs: ExecutionGraphStore;

  // Integrations
  readonly core: CoreAdapter | null;
  readonly payments: PaymentsAdapter | null;
  readonly workspaceState: WorkspaceStateAdapter | null;

  // Governance
  readonly policyEngine: PolicyEngine;
  readonly approvals: ApprovalManager;
  readonly audit: AuditEmitter;
  readonly llmResponseGuard: LLMResponseGuard;
  readonly supplyChainGuard: SupplyChainGuard;
  private readonly plugins: RuntimePlugin[] = [];
  readonly securityPackManager: SecurityPolicyPackManager;
  private readonly canaryToken: string;
  private readonly canaryDeployer: CanaryCredentialDeployer | null = null;

  // Agent Registry Bridge (SDK ↔ Portal sync)
  readonly registryBridge: AgentRegistryBridge | null = null;
  private registryReady: Promise<void> | null = null;

  // Config
  private enableTracing: boolean;
  private enableCheckpoints: boolean;
  private onEvent?: (event: unknown) => void;
  private bootstrapReport: RuntimeBootstrapReport;
  private latestContextPlans = new Map<string, ContextPlan>();
  private latestSessionSnapshots = new Map<string, RunSessionSnapshot>();
  private latestExecutionNodeIds = new Map<string, string>();
  private traceHookActive = false;
  private handoffHandlers = new Map<string, HandoffHandler>();
  private retrievalPolicy: ContextRetrievalPolicy;
  private memoryProposalValidators: MemoryProposalValidator[];
  private homeostatic: HomeostaticContextEngine | null = null;
  private compactor: Compactor | null = null;
  private progressiveToolDisclosure = false;

  // Identity & Integrity
  private identityClaims: AgentIdentityClaims | null = null;
  private integrityBinding: AgentIntegrityBinding | null = null;
  private integrityReady: Promise<void> | null = null;

  // Intent Verification
  private intentVerifier: IntentVerifier | null = null;

  // Standalone Security Gateway (dual-layer enforcement)
  private securityGateway: RuntimeOptions['securityGateway'] | null = null;

  // Run counter
  private runCounter = 0;

  constructor(definition: AgentDefinition, options?: RuntimeOptions) {
    this.definition = definition;

    // Init sub-systems
    this.events = new EventBus();
    this.eventLog = new EventLog();
    this.models = new ModelRegistry();
    this.tools = new ToolRegistry();
    this.toolValidator = new ToolValidator();
    this.toolExecutor = new ToolExecutor(this.tools, this.toolValidator);
    this.hooks = new HookRegistry();
    this.hookRunner = new HookRunner(this.hooks);
    this.context = new ContextCompiler();
    this.memory = new MemoryManager({
      ...definition.memory,
      store: options?.memoryStore as MemoryStore | undefined,
    });
    this.checkpoints = new CheckpointManager(
      options?.checkpointStore as CheckpointStore | undefined,
    );
    this.transcripts = options?.transcriptStore ?? new InMemoryTranscriptStore();
    this.executionSurface = new ExecutionSurfaceRegistry();
    this.runStore = options?.runStore ?? new InMemoryRunStore();
    this.threadStore = options?.threadStore ?? new InMemoryThreadStore();
    this.executionGraphs = options?.executionGraphStore ?? new InMemoryExecutionGraphStore();
    this.memoryProposalValidators = [...(options?.memoryProposalValidators ?? [])];

    // Register model providers
    if (options?.modelProviders) {
      for (const [, provider] of Object.entries(options.modelProviders)) {
        if (provider && typeof provider === 'object' && 'name' in provider) {
          this.models.register(provider as ModelProvider);
        }
      }
    }

    // Initialise progressive-tool-disclosure flag early so that the
    // tool-registration block below can auto-register the load_tool built-in.
    this.progressiveToolDisclosure = options?.progressiveToolDisclosure === true;

    // Register tools
    if (definition.tools) {
      for (const tool of definition.tools) {
        this.tools.register(tool);
        this.executionSurface.registerTool(tool);
      }
    }

    // Progressive tool disclosure: register the load_tool built-in so
    // the model can fetch full schemas on demand.
    if (this.progressiveToolDisclosure) {
      const loadTool = createLoadToolBuiltin((name) => this.tools.get(name));
      this.tools.register(loadTool);
      this.executionSurface.registerTool(loadTool);
    }

    if (options?.executionCapabilities) {
      for (const capability of options.executionCapabilities as ExecutableCapability[]) {
        this.executionSurface.register(capability);
      }
    }

    // Register hooks
    if (definition.hooks) {
      for (const [, hooks] of Object.entries(definition.hooks)) {
        for (const hook of hooks) {
          this.hooks.register(hook);
        }
      }
    }

    // Integrations
    this.core = options?.veridexSDK
      ? new CoreAdapter({ sdk: options.veridexSDK })
      : null;
    this.payments = options?.agentWallet
      ? new PaymentsAdapter({
          payments: options.agentWallet,
          budgetLimits: definition.payments
            ? {
                maxPerTransaction: definition.payments.perTransactionLimitUSD,
                maxPerRun: definition.payments.dailyLimitUSD,
              }
            : undefined,
        })
      : null;
    this.workspaceState = options?.workspaceStateProvider
      ? new WorkspaceStateAdapter(options.workspaceStateProvider)
      : null;
    this.retrievalPolicy = options?.retrievalPolicy ?? DEFAULT_RETRIEVAL_POLICY;

    // Optional fidelity-aware (homeostatic) context engine.
    if (options?.homeostatic) {
      this.homeostatic =
        options.homeostatic instanceof HomeostaticContextEngine
          ? options.homeostatic
          : new HomeostaticContextEngine(
              options.homeostatic as HomeostaticContextEngineOptions,
            );
    }
    this.compactor = options?.compactor ?? null;

    // Config
    this.enableTracing = options?.enableTracing !== false;
    this.enableCheckpoints = options?.enableCheckpoints === true;
    this.onEvent = options?.onEvent as ((event: unknown) => void) | undefined;
    if (options?.handoffHandlers) {
      for (const [target, handler] of Object.entries(options.handoffHandlers)) {
        this.handoffHandlers.set(target, handler);
      }
    }

    // Governance
    this.policyEngine = new PolicyEngine();
    this.approvals = new ApprovalManager();
    this.audit = new AuditEmitter();

    // LLM Response Guard — validates model outputs before tool execution.
    // Defaults to a no-op so the runtime has zero hard dependency on payments;
    // a real guard can be supplied via `options.llmResponseGuard` or a plugin.
    this.canaryToken = (options as Record<string, unknown>)?.llmGuardCanaryToken as string
      ?? generateCanaryToken();
    const injectedLLMGuard = (options as Record<string, unknown>)?.llmResponseGuard as
      | LLMResponseGuard
      | undefined;
    this.llmResponseGuard = injectedLLMGuard ?? new NoopLLMResponseGuard();
    const injectedSupplyChainGuard = (options as Record<string, unknown>)?.supplyChainGuard as
      | SupplyChainGuard
      | undefined;
    this.supplyChainGuard = injectedSupplyChainGuard ?? new NoopSupplyChainGuard();

    // ── Runtime plugins ── install before the supply-chain check so plugins
    // can swap in a real guard implementation.
    const installedPlugins = (options as Record<string, unknown>)?.plugins as
      | RuntimePlugin[]
      | undefined;
    if (installedPlugins && installedPlugins.length > 0) {
      const pluginCtx: RuntimePluginContext = {
        agentId: this.definition.id,
        canaryToken: this.canaryToken,
        setLLMResponseGuard: (g: LLMResponseGuard) => {
          (this as { llmResponseGuard: LLMResponseGuard }).llmResponseGuard = g;
        },
        setSupplyChainGuard: (g: SupplyChainGuard) => {
          (this as { supplyChainGuard: SupplyChainGuard }).supplyChainGuard = g;
        },
        registerTool: (tool) => {
          this.tools.register(tool);
          this.executionSurface.registerTool(tool);
        },
        registerHook: (hook) => {
          this.hooks.register(hook);
        },
        registerPolicy: (rule) => {
          this.policyEngine.register(rule);
        },
      };
      for (const plugin of installedPlugins) {
        plugin.install(pluginCtx);
        this.plugins.push(plugin);
      }
    }

    // Register policy rules from options
    if (options?.policyRules) {
      for (const rule of options.policyRules as PolicyRule[]) {
        this.policyEngine.register(rule);
      }
    }

    // Register approval routes from options
    if (options?.approvalRoutes) {
      for (const route of options.approvalRoutes as ApprovalRoute[]) {
        this.approvals.addRoute(route);
      }
    }

    // Register approval handlers from options
    if (options?.approvalHandlers) {
      for (const [mode, handler] of Object.entries(options.approvalHandlers)) {
        this.approvals.registerHandler(mode as ApprovalMode, handler as ApprovalHandler);
      }
    }

    // Register audit sinks from options
    if (options?.auditSinks) {
      for (const sink of options.auditSinks as AuditSink[]) {
        this.audit.addSink(sink);
      }
    }

    // Wire event forwarding
    if (this.onEvent) {
      const handler = this.onEvent;
      this.events.onAny((event) => handler(event));
    }
    if (this.enableTracing) {
      this.events.onAny((event) => this.eventLog.append(event));
    }

    this.bootstrapReport = buildRuntimeBootstrapReport({
      agentId: this.definition.id,
      modelProviders: this.models.list(),
      defaultModelProvider: this.definition.model.provider,
      capabilitySummary: this.executionSurface.summary(),
      activePolicyCount: this.policyEngine.list().length,
      approvalManagerEnabled: true,
      checkpointManagerEnabled: this.enableCheckpoints,
      transcriptStoreMode: this.transcripts.mode,
      transportAvailability: options?.transportAvailability,
      identityWired: this.core?.isAvailable() ?? false,
      paymentsWired: this.payments?.isAvailable() ?? false,
      controlPlaneConnected: options?.controlPlaneConnected ?? null,
      maxTurns: this.definition.maxTurns ?? 25,
      maxTokenBudget: this.definition.maxTokens,
      contextTokenBudget: DEFAULT_CONTEXT_TOKEN_BUDGET,
      historyTurns: DEFAULT_HISTORY_TURNS,
    });

    // ── Supply Chain Guard — startup environment verification ──
    const envCheck = this.supplyChainGuard.verifyEnvironment();
    if (!envCheck.safe) {
      const criticalIssues = envCheck.issues.filter((i) => i.severity === 'critical');
      if (criticalIssues.length > 0) {
        throw new Error(
          `AgentRuntime startup blocked: supply chain environment tampering detected — ${criticalIssues.map((i) => i.detail).join('; ')}`,
        );
      }
      // Non-critical issues → log warnings during bootstrap
      for (const issue of envCheck.issues) {
        console.warn(`[SupplyChainGuard] ${issue.severity}: ${issue.detail} (source: ${issue.source ?? 'unknown'})`);
      }
    }

    // ── Default Security Packs — Tier 1 + Tier 2 defenses ──
    this.securityPackManager = new SecurityPolicyPackManager(this.policyEngine, this.hooks);
    const securityOpts = (options as Record<string, unknown>)?.securityPacks as Record<string, unknown> | undefined;
    const disabledPacks = new Set<string>(
      (securityOpts?.disabledPacks as string[] | undefined) ?? [],
    );

    // Registry of all default security packs, keyed by pack ID
    const defaultSecurityPacks = [
      // Original 6 packs
      { id: 'security:injection-detection', factory: () => injectionDetectionPack() },
      { id: 'security:tool-poisoning', factory: () => toolPoisoningPack() },
      { id: 'security:handoff-safety', factory: () => handoffSafetyPack() },
      { id: 'security:model-restriction', factory: () => modelRestrictionPack() },
      { id: 'security:budget-ceiling', factory: () => budgetCeilingPack() },
      { id: 'security:endpoint-allowlist', factory: () => endpointAllowlistPack({ allowedEndpoints: ['https://api.openai.com/**', 'https://api.anthropic.com/**', 'https://generativelanguage.googleapis.com/**', 'https://api.mistral.ai/**', 'https://api.groq.com/**', 'https://api.together.xyz/**', 'https://api.fireworks.ai/**'] }) },
      // Tier 1: AC-1, AC-1.a, AC-2 gap closures
      { id: 'security:shell-install-gate', factory: () => shellInstallGatePack() },
      { id: 'security:request-secret-redaction', factory: () => requestSecretRedactionPack() },
      { id: 'security:intent-verification', factory: () => intentVerificationPack() },
      // Tier 2: Forensics, anomaly detection, canary, TLS
      { id: 'security:response-hash-logging', factory: () => responseHashLoggingPack() },
      { id: 'security:persistent-transparency-log', factory: () => persistentTransparencyLogPack() },
      { id: 'security:cross-turn-anomaly', factory: () => crossTurnAnomalyPack() },
      { id: 'security:canary-credentials', factory: () => canaryCredentialPack() },
      { id: 'security:tls-cert-pinning', factory: () => tlsCertPinningPack() },
    ];

    for (const { id, factory } of defaultSecurityPacks) {
      if (!disabledPacks.has(id)) {
        try {
          const pack = factory();
          this.securityPackManager.registerPack(pack);
          // Extract canary deployer reference if this is the canary pack
          if (id === 'security:canary-credentials' && '_deployer' in pack) {
            (this as unknown as { canaryDeployer: CanaryCredentialDeployer | null }).canaryDeployer =
              (pack as unknown as { _deployer: CanaryCredentialDeployer })._deployer;
          }
        } catch (err) {
          console.warn(`[SecurityPackManager] Failed to register pack '${id}':`, err);
        }
      }
    }

    // Identity & Integrity
    if (options?.identityClaims) {
      this.identityClaims = options.identityClaims;
      // Compute integrity binding asynchronously; callers can await via getIntegrityBinding()
      this.integrityReady = buildIntegrityBinding(
        this.definition,
        this.definition.tools ?? [],
      ).then((binding) => {
        this.integrityBinding = binding;
      });
    } else if (options?.enableIntegrity) {
      // Compute integrity without explicit claims
      this.integrityReady = buildIntegrityBinding(
        this.definition,
        this.definition.tools ?? [],
      ).then((binding) => {
        this.integrityBinding = binding;
      });
    }

    // Intent Verification
    if (options?.intentVerifier) {
      this.intentVerifier = options.intentVerifier;
    }

    // ── Agent Registry Bridge — SDK ↔ Portal bidirectional sync ──
    if (options?.registryBridge) {
      const bridge = new AgentRegistryBridge(options.registryBridge);
      (this as { registryBridge: AgentRegistryBridge | null }).registryBridge = bridge;
      const autoRegister = options.registryBridge.autoRegister !== false;
      if (autoRegister) {
        this.registryReady = bridge.register(this.definition).then(() => {
          // Registration successful — agent is now visible in the portal
        }).catch((err) => {
          console.warn('[AgentRegistryBridge] Auto-registration failed:', err);
        });
      }
    }

    // ── Standalone Security Gateway (dual-layer enforcement) ──
    if (options?.securityGateway) {
      this.securityGateway = options.securityGateway;
    }
  }

  /** Get the most recently compiled context plan for a run. */
  getLatestContextPlan(runId?: string): ContextPlan | null {
    if (runId) {
      return this.latestContextPlans.get(runId) ?? null;
    }

    const latestRunId = [...this.latestContextPlans.keys()].at(-1);
    if (!latestRunId) return null;
    return this.latestContextPlans.get(latestRunId) ?? null;
  }

  /** Get the agent's identity claims (null if not configured). */
  getIdentityClaims(): AgentIdentityClaims | null {
    return this.identityClaims;
  }

  /** Get the agent's integrity binding. Awaits computation if still in progress. */
  async getIntegrityBinding(): Promise<AgentIntegrityBinding | null> {
    if (this.integrityReady) {
      await this.integrityReady;
    }
    return this.integrityBinding;
  }

  /** Await registry bridge auto-registration completion (no-op if bridge not configured). */
  async awaitRegistration(): Promise<string | null> {
    if (this.registryReady) {
      await this.registryReady;
    }
    return this.registryBridge?.getRegisteredAgentId() ?? null;
  }

  /**
   * Load a portal-created agent's metadata from the relayer and return a
   * partial AgentDefinition stub. The caller must supply model config and
   * tools to create a full runtime.
   */
  static async loadFromPortal(
    registryConfig: AgentRegistryConfig,
    agentId: string,
  ): Promise<(Partial<AgentDefinition> & { id: string; name: string }) | null> {
    const bridge = new AgentRegistryBridge(registryConfig);
    const agent = await bridge.getAgent(agentId);
    if (!agent) return null;
    return bridge.toDefinitionStub(agent);
  }

  /**
   * Build a tamper-evident response envelope for a run result.
   * Requires identity claims to be configured.
   */
  async buildResponseEnvelope(params: {
    runId: string;
    output: string;
    outputMetadata?: Record<string, unknown>;
    model: string;
    provider: string;
    policySnapshot?: Array<{ ruleId: string; verdict: string; riskScore: number; evaluatedAt: number }>;
  }): Promise<ResponseEnvelope | null> {
    if (!this.identityClaims) return null;
    const integrity = await this.getIntegrityBinding();
    if (!integrity) return null;
    return buildResponseEnvelope({
      runId: params.runId,
      identity: this.identityClaims,
      integrity,
      output: params.output,
      outputMetadata: params.outputMetadata,
      model: params.model,
      provider: params.provider,
      policySnapshot: params.policySnapshot,
    });
  }

  /** Get the runtime bootstrap/setup report. */
  getBootstrapReport(): RuntimeBootstrapReport {
    return {
      ...this.bootstrapReport,
      modelProviders: [...this.bootstrapReport.modelProviders],
      capabilitySources: this.bootstrapReport.capabilitySources.map((entry) => ({ ...entry })),
      transportAvailability: { ...this.bootstrapReport.transportAvailability },
      veridex: { ...this.bootstrapReport.veridex },
      defaults: { ...this.bootstrapReport.defaults },
    };
  }

  /** Get the most recently captured session snapshot for a run. */
  getLatestSessionSnapshot(runId?: string): RunSessionSnapshot | null {
    if (runId) {
      return this.latestSessionSnapshots.get(runId) ?? null;
    }

    const latestRunId = [...this.latestSessionSnapshots.keys()].at(-1);
    if (!latestRunId) return null;
    return this.latestSessionSnapshots.get(latestRunId) ?? null;
  }

  /** Load the durable run record for a run if one exists. */
  async getStoredRunRecord(runId: string): Promise<StoredRunRecord | null> {
    return this.runStore.read(runId);
  }

  /** Load the durable thread record for a run if one exists. */
  async getStoredThread(runId: string): Promise<ThreadRecord | null> {
    return this.threadStore.read(this.getThreadId(runId));
  }

  /** List checkpoints for a run. */
  async listCheckpoints(runId: string) {
    return this.checkpoints.list(runId);
  }

  /** Load a stored checkpoint. */
  async loadCheckpoint(checkpointId: string) {
    return this.checkpoints.load(checkpointId);
  }

  private getThreadId(runId: string): string {
    return `thread_${runId}`;
  }

  private async persistRunState(run: Run, session?: RunSessionSnapshot): Promise<void> {
    const transcript = await this.transcripts.getRef(run.id);
    await this.runStore.write({
      run: cloneRun(run),
      latestContextSummary: this.buildContextPlanSummary(this.latestContextPlans.get(run.id)),
      sessionSnapshot: session
        ? {
            updatedAt: session.updatedAt,
            transcript: session.transcript,
            executionGraph: session.executionGraph,
          }
        : undefined,
      transcript,
      bootstrapReport: this.getBootstrapReport(),
      updatedAt: Date.now(),
    });
  }

  private async persistThreadState(run: Run, session?: RunSessionSnapshot): Promise<void> {
    const transcript = session?.transcript ?? await this.transcripts.getRef(run.id);
    await this.threadStore.write({
      id: this.getThreadId(run.id),
      runId: run.id,
      agentId: run.agentId,
      title: run.input.slice(0, 120),
      state: run.state,
      transcript,
      executionGraph: session?.executionGraph ?? await this.executionGraphs.getRef(run.id),
      metadata: run.metadata ? { ...run.metadata } : undefined,
      createdAt: run.createdAt,
      updatedAt: Date.now(),
    });
  }

  private buildActorRef(type: ActorRef['type'], id: string, label?: string): ActorRef {
    return { type, id, label };
  }

  private async appendExecutionNode(
    runId: string,
    input: Omit<ExecutionNode, 'id' | 'runId' | 'timestamp'>,
    relation: 'follows' | 'triggered' | 'validated_by' | 'approved_by' | 'invoked' | 'mutates' | 'recorded_as' = 'follows',
  ): Promise<ExecutionNode> {
    const node: ExecutionNode = {
      ...input,
      id: `xnode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      runId,
      timestamp: Date.now(),
      metadata: input.metadata ? { ...input.metadata } : undefined,
    };
    await this.executionGraphs.appendNode(node);
    const previousNodeId = this.latestExecutionNodeIds.get(runId);
    if (previousNodeId) {
      await this.executionGraphs.appendEdge({
        id: `xedge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        runId,
        from: previousNodeId,
        to: node.id,
        relation,
        timestamp: Date.now(),
      });
    }
    this.latestExecutionNodeIds.set(runId, node.id);
    return node;
  }

  private async recordSideEffectReceipt(receipt: SideEffectReceipt): Promise<SideEffectReceipt> {
    await this.executionGraphs.recordReceipt(receipt);
    await this.appendExecutionNode(receipt.runId, {
      turnIndex: receipt.turnIndex,
      kind: 'side_effect_receipt',
      phase: 'receipt',
      actor: this.buildActorRef('system', this.definition.id, this.definition.name),
      capabilityName: receipt.capabilityName,
      resource: receipt.resource,
      status: receipt.status === 'failed' ? 'failure' : receipt.status === 'skipped' ? 'skipped' : 'success',
      summary: receipt.summary,
      metadata: {
        receiptId: receipt.id,
        idempotencyKey: receipt.idempotencyKey,
      },
    }, 'recorded_as');
    this.emitEvent({
      id: eventId(),
      type: 'side_effect_receipt_recorded',
      runId: receipt.runId,
      agentId: this.definition.id,
      turnIndex: receipt.turnIndex,
      timestamp: Date.now(),
      data: {
        capabilityName: receipt.capabilityName,
        receiptId: receipt.id,
        idempotencyKey: receipt.idempotencyKey,
        status: receipt.status,
      },
    });
    return receipt;
  }

  private classifyToolExecutionOutcome(
    execution: ToolExecutionResult,
    blockedState?: 'approval_blocked' | 'policy_blocked',
  ): ToolExecutionOutcome {
    if (blockedState) return blockedState;
    if (execution.outcome) return execution.outcome;
    if (execution.result.success === false) {
      return execution.retryCount > 0 ? 'transient_failure' : 'permanent_failure';
    }
    return 'success';
  }

  private buildIdempotencyKey(
    runId: string,
    turnIndex: number,
    toolCall: ToolCall,
  ): IdempotencyKey {
    return `${runId}:${turnIndex}:${toolCall.id}:${toolCall.name}`;
  }

  private async validateMemoryProposal(
    request: MemoryWriteRequest,
  ): Promise<MemoryProposalValidationResult> {
    const proposal: MemoryProposal = {
      kind: request.entry.kind ?? 'note',
      request,
      evidence: request.entry.evidenceRef ? [request.entry.evidenceRef] : undefined,
    };
    const existingEntries = await this.memory.search({
      kind: request.entry.kind,
      text: request.entry.content,
      limit: 25,
    });
    const issues: MemoryProposalValidationResult['issues'] = [];

    if (existingEntries.some((entry) => entry.content === request.entry.content)) {
      issues.push({
        code: 'dedup',
        severity: request.overwriteStrategy === 'skip' ? 'warn' : 'info',
        message: 'An equivalent memory entry already exists.',
      });
    }
    if (/sk-[a-z0-9]{8,}|BEGIN [A-Z ]+PRIVATE KEY|password\s*=|api[_-]?key/i.test(request.entry.content)) {
      issues.push({
        code: 'secrecy',
        severity: 'error',
        message: 'Memory proposal looks like it may contain a secret or credential.',
      });
    }
    if ((request.entry.confidence ?? 1) < 0.5) {
      issues.push({
        code: 'confidence',
        severity: 'warn',
        message: 'Memory proposal has low confidence and may require review.',
      });
    }
    if (request.entry.kind === 'workspace_state' && request.entry.stateRef?.resourceType && request.entry.stateRef?.resourceId) {
      const conflicting = await this.memory.search({
        kind: 'workspace_state',
        resourceType: request.entry.stateRef.resourceType,
        resourceId: request.entry.stateRef.resourceId,
        limit: 10,
      });
      if (conflicting.some((entry) => entry.content !== request.entry.content)) {
        issues.push({
          code: 'conflict',
          severity: 'warn',
          message: 'Existing workspace-state entries disagree with this proposal.',
        });
      }
      if (!request.entry.stateRef.version) {
        issues.push({
          code: 'staleness',
          severity: 'warn',
          message: 'Workspace-state proposal does not declare an expected version.',
        });
      }
    }

    let accepted = issues.every((issue) => issue.severity !== 'error');
    let normalizedProposal = proposal;

    for (const validator of this.memoryProposalValidators) {
      const result = await validator.validate(normalizedProposal, { existingEntries });
      issues.push(...result.issues);
      accepted = accepted && result.accepted;
      if (result.normalizedProposal) {
        normalizedProposal = result.normalizedProposal;
      }
    }

    return {
      accepted,
      issues,
      normalizedProposal,
    };
  }

  /** Resume a suspended run from a previously saved checkpoint. */
  async resumeFromCheckpoint(
    checkpointId: string,
    options?: ResumeRunOptions,
  ): Promise<RunResult> {
    const checkpoint = await this.checkpoints.load(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint '${checkpointId}' not found`);
    }

    const parsed = this.checkpoints.parseState(checkpoint) as unknown as RunCheckpointState;
    if (!parsed.run) {
      throw new Error(`Checkpoint '${checkpointId}' does not contain a run snapshot`);
    }

    const run: Run = {
      ...parsed.run,
      turns: [...parsed.run.turns],
      turnOutcomes: [...(parsed.run.turnOutcomes ?? [])],
      policyDecisions: [...(parsed.run.policyDecisions ?? [])],
      approvalDecisions: [...(parsed.run.approvalDecisions ?? [])],
      updatedAt: Date.now(),
    };
    await this.transcripts.replace(run.id, parsed.transcriptEntries ?? []);
    const startTurnIndex = (parsed.turnIndex ?? run.turns.length - 1) + 1;

    const approval = options?.approval;
    if (run.state === 'waiting_for_approval') {
      const lastTurn = run.turns[run.turns.length - 1];
      if (!approval) {
        return await this.buildRunResult(run);
      }

        if (!approval.approved) {
          if (approval.requestId) {
            const decision = this.approvals.resolve(
            approval.requestId,
            false,
            approval.approver ?? 'operator',
            approval.reason,
          );
          if (decision) {
            run.approvalDecisions.push(decision);
            await this.appendTranscriptEntry({
              runId: run.id,
              agentId: this.definition.id,
              turnIndex: lastTurn?.index ?? parsed.turnIndex ?? 0,
              kind: 'approval_event',
              content: `Approval denied by ${decision.decidedBy}: ${decision.reason ?? 'No reason provided'}`,
              metadata: {
                requestId: decision.requestId,
                approved: false,
              },
            });
          }
          }
          this.emitEvent({
            id: eventId(),
            type: 'approval_resolved',
            runId: run.id,
            agentId: this.definition.id,
            turnIndex: lastTurn?.index ?? parsed.turnIndex ?? 0,
            timestamp: Date.now(),
            data: {
              requestId: approval.requestId,
              approved: false,
              approver: approval.approver ?? 'operator',
              reason: approval.reason,
            },
          });
          await this.runHooks('afterApprovalDecision', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex: lastTurn?.index ?? parsed.turnIndex ?? 0,
          approved: false,
          requestId: approval.requestId,
          approver: approval.approver ?? 'operator',
          reason: approval.reason,
        }, { runId: run.id, turnIndex: lastTurn?.index });
        run.state = 'failed';
        run.error = approval.reason ?? 'Approval denied';
        return await this.finalizeRun(run);
      }

      if (
        lastTurn &&
        lastTurn.proposal.type === 'tool_call' &&
        lastTurn.result &&
        typeof lastTurn.result === 'object' &&
        'waitingForApproval' in (lastTurn.result as Record<string, unknown>)
      ) {
        lastTurn.result = await this.executeProposal(
          run,
          lastTurn.index,
          lastTurn.proposal,
          { approval },
        );
        run.state = 'running';
      } else {
        run.state = 'running';
      }

      if (approval.requestId) {
        const decision = this.approvals.resolve(
          approval.requestId,
          true,
          approval.approver ?? 'operator',
          approval.reason,
        );
        if (decision) {
          run.approvalDecisions.push(decision);
          await this.appendTranscriptEntry({
            runId: run.id,
            agentId: this.definition.id,
            turnIndex: lastTurn?.index ?? parsed.turnIndex ?? 0,
            kind: 'approval_event',
            content: `Approval granted by ${decision.decidedBy}: ${decision.reason ?? 'Approved'}`,
            metadata: {
              requestId: decision.requestId,
              approved: true,
            },
          });
        }
      }
      this.emitEvent({
        id: eventId(),
        type: 'approval_resolved',
        runId: run.id,
        agentId: this.definition.id,
        turnIndex: lastTurn?.index ?? parsed.turnIndex ?? 0,
        timestamp: Date.now(),
        data: {
          requestId: approval.requestId,
          approved: true,
          approver: approval.approver ?? 'operator',
          reason: approval.reason,
        },
      });
      if (!lastTurn || lastTurn.proposal.type !== 'tool_call') {
        await this.runHooks('afterApprovalDecision', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex: lastTurn?.index ?? parsed.turnIndex ?? 0,
          approved: true,
          requestId: approval.requestId,
          approver: approval.approver ?? 'operator',
          reason: approval.reason,
        }, { runId: run.id, turnIndex: lastTurn?.index });
      }
    }

    return this.executeRunLoop(run, startTurnIndex, { skipBeforeRun: true });
  }

  /** Execute a full agent run. */
  async run(input: string, metadata?: Record<string, unknown>): Promise<RunResult> {
    const runId = `run_${++this.runCounter}_${Date.now()}`;
    this.payments?.resetRunSpend();

    const run: Run = {
      id: runId,
      agentId: this.definition.id,
      state: 'queued',
      input,
      turns: [],
      turnOutcomes: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      policyDecisions: [],
      approvalDecisions: [],
      metadata,
    };

    await this.persistRunState(run);
    await this.persistThreadState(run);
    await this.appendExecutionNode(run.id, {
      kind: 'actor',
      phase: 'proposal',
      actor: this.buildActorRef('agent', this.definition.id, this.definition.name),
      status: 'success',
      summary: `Run started for agent ${this.definition.name}`,
      metadata: { input },
    });

    this.emitEvent({
      id: eventId(),
      type: 'bootstrap_report_generated',
      runId,
      agentId: this.definition.id,
      timestamp: Date.now(),
      data: { report: this.getBootstrapReport() },
    });

    this.emitEvent({
      id: eventId(),
      type: 'run_started',
      runId,
      agentId: this.definition.id,
      timestamp: Date.now(),
      data: { input },
    });

    await this.appendTranscriptEntry({
      runId,
      agentId: this.definition.id,
      kind: 'system_note',
      content: `Runtime bootstrap ready with ${this.bootstrapReport.capabilityCount} capabilities and ${this.bootstrapReport.modelProviders.length} model providers.`,
      metadata: {
        type: 'bootstrap_report',
      },
    });
    await this.appendTranscriptEntry({
      runId,
      agentId: this.definition.id,
      kind: 'user_input',
      content: input,
      metadata,
    });

    // beforeRun hook
    const beforeRun = await this.runHooks('beforeRun', {
      runId, agentId: this.definition.id, input, state: run.state,
    }, { runId });
    if (beforeRun.override === 'deny') {
      run.state = 'failed';
      run.error = `Run denied by hook: ${beforeRun.reasons.join('; ')}`;
      return this.finalizeRun(run);
    }

    return this.executeRunLoop(run, 0);
  }

  /**
   * Execute an agent run and stream all events as they occur.
   *
   * Returns an AsyncGenerator that yields TraceEvent objects, including
   * `token_streamed` events for real-time token output. The final yield
   * is always a `run_completed` or `run_failed` event.
   *
   * ```ts
   * for await (const event of runtime.streamRun('Hello!')) {
   *   if (event.type === 'token_streamed') process.stdout.write(event.data.token);
   *   if (event.type === 'run_completed') console.log('Done:', event.data.output);
   * }
   * ```
   */
  async *streamRun(
    input: string,
    metadata?: Record<string, unknown>,
  ): AsyncGenerator<TraceEvent, void, undefined> {
    // Buffer for events emitted during the run
    const buffer: TraceEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const listener = (event: TraceEvent) => {
      buffer.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    // Subscribe to all events
    const unsubscribe = this.events.onAny(listener);

    // Start the run (non-blocking)
    const runPromise = this.run(input, metadata).then(
      () => { done = true; if (resolve) { resolve(); resolve = null; } },
      () => { done = true; if (resolve) { resolve(); resolve = null; } },
    );

    try {
      while (!done || buffer.length > 0) {
        if (buffer.length > 0) {
          yield buffer.shift()!;
        } else if (!done) {
          // Wait for next event
          await new Promise<void>((r) => { resolve = r; });
        }
      }
    } finally {
      unsubscribe();
      await runPromise;
    }
  }

  /** Continue executing a run from the given turn index. */
  private async executeRunLoop(
    run: Run,
    startTurnIndex: number,
    options?: { skipBeforeRun?: boolean },
  ): Promise<RunResult> {
    run.state = 'running';
    const maxTurns = this.definition.maxTurns ?? 25;

    for (let turnIndex = startTurnIndex; turnIndex < maxTurns; turnIndex++) {
      // beforeTurn hook
      const beforeTurn = await this.runHooks('beforeTurn', {
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        input: run.input,
      }, { runId: run.id, turnIndex });
      if (beforeTurn.override === 'deny') {
        run.state = 'failed';
        run.error = `Turn ${turnIndex} denied by hook: ${beforeTurn.reasons.join('; ')}`;
        break;
      }

      try {
        const { turn, outcome } = await this.executeTurn(run, turnIndex);
        run.turns.push(turn);
        run.turnOutcomes.push(outcome);

        // Accumulate usage
        run.totalUsage.inputTokens += turn.usage.inputTokens;
        run.totalUsage.outputTokens += turn.usage.outputTokens;
        run.totalUsage.totalTokens += turn.usage.totalTokens;
        run.updatedAt = Date.now();
        await this.persistRunState(run);
        await this.persistThreadState(run);

        // Check token budget
        if (this.definition.maxTokens && run.totalUsage.totalTokens > this.definition.maxTokens) {
          run.state = 'failed';
          run.error = `Token budget exceeded (${run.totalUsage.totalTokens}/${this.definition.maxTokens})`;
          run.turnOutcomes[run.turnOutcomes.length - 1] = {
            ...outcome,
            stopReason: 'max_budget_reached',
            runState: 'failed',
          };
          break;
        }

        // Determine next state based on proposal
        const nextState = this.getNextState(turn.proposal, turn.result);
        run.state = nextState;
        run.turnOutcomes[run.turnOutcomes.length - 1] = {
          ...outcome,
          runState: nextState,
          stopReason: this.getTurnStopReason(nextState, turn.proposal, turn.result, outcome.toolExecutionSummaries),
        };

        if (nextState === 'completed') {
          const control = turn.result as ProposalControlResult | undefined;
          run.output = control?.output
            ?? (turn.proposal.type === 'final_answer'
              ? turn.proposal.answer
              : turn.modelOutput);
          break;
        }

        if (nextState === 'failed') {
          const turnResult = turn.result as ProposalControlResult | undefined;
          run.error = turnResult?.reasons?.join('; ') ?? 'Run blocked';
          break;
        }

        if (nextState === 'waiting_for_approval' || nextState === 'waiting_for_handoff' || nextState === 'suspended') {
          // Checkpoint if enabled
          if (this.enableCheckpoints) {
            const checkpoint = await this.checkpoints.save(run.id, this.definition.id, turnIndex, {
              run,
              turnIndex,
              transcriptEntries: await this.transcripts.list(run.id),
            }, nextState === 'waiting_for_approval' ? 'approval' : 'suspend');
            this.emitEvent({
              id: eventId(),
              type: 'run_checkpointed',
              runId: run.id,
              agentId: this.definition.id,
              turnIndex,
              timestamp: Date.now(),
              data: {
                checkpointId: checkpoint.id,
                turnIndex,
                state: nextState,
              },
            });
          }
          break;
        }

        // afterTurn hook
        await this.runHooks('afterTurn', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          input: run.input,
          output: turn.modelOutput,
        }, { runId: run.id, turnIndex });
      } catch (err) {
        // onError hook
        await this.runHooks('onError', {
          runId: run.id, agentId: this.definition.id, turnIndex,
          error: err instanceof Error ? err : new Error(String(err)),
          phase: 'turn',
        }, { runId: run.id, turnIndex });

        run.state = 'failed';
        run.error = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    // If we exhausted turns
    if (run.state === 'running') {
      run.state = 'completed';
      const lastTurn = run.turns[run.turns.length - 1];
      run.output = lastTurn?.modelOutput ?? 'Max turns reached without a final answer.';
      if (run.turnOutcomes.length > 0) {
        const lastOutcome = run.turnOutcomes[run.turnOutcomes.length - 1];
        run.turnOutcomes[run.turnOutcomes.length - 1] = {
          ...lastOutcome,
          stopReason: 'max_turns_reached',
          runState: 'completed',
        };
      }
    }

    // afterRun hook
    if (!options?.skipBeforeRun || startTurnIndex > 0) {
      await this.runHooks('afterRun', {
        runId: run.id,
        agentId: this.definition.id,
        input: run.input,
        state: run.state,
      }, { runId: run.id });
    }

    return await this.finalizeRun(run);
  }

  /** Execute a single turn. */
  private async executeTurn(
    run: Run,
    turnIndex: number,
  ): Promise<{ turn: Turn; outcome: TurnOutcome }> {
    const provider = this.models.get(this.definition.model.provider);
    if (!provider) {
      throw new Error(`Model provider '${this.definition.model.provider}' not registered`);
    }
    const turnEventPosition = this.eventLog.size;

    // Build messages
    const { messages, contextPlan } = await this.buildMessages(run, turnIndex);
    this.latestContextPlans.set(run.id, contextPlan);

    this.emitEvent({
      id: eventId(),
      type: 'context_compiled',
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      timestamp: Date.now(),
      data: {
        totalTokens: contextPlan.totalTokens,
        sectionCount: contextPlan.sections.length,
        hadTruncation: contextPlan.hadTruncation,
      },
    });

    // Build tool definitions for model
    const toolDefs = this.buildToolDefinitions();

    // beforeModelCall hook
    await this.runHooks('beforeModelCall', {
      runId: run.id, agentId: this.definition.id, turnIndex,
      messages, tools: toolDefs,
    }, { runId: run.id, turnIndex });

    this.emitEvent({
      id: eventId(),
      type: 'model_call_started',
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      timestamp: Date.now(),
      data: {
        provider: this.definition.model.provider,
        model: this.definition.model.model,
      },
    });

    // Call model
    let tokenIndex = 0;
    const onToken = this.enableTracing
      ? (token: string) => {
          this.emitEvent({
            id: eventId(),
            type: 'token_streamed',
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            timestamp: Date.now(),
            data: { token, tokenIndex: tokenIndex++ },
          });
        }
      : undefined;

    const response = await provider.complete(messages, {
      temperature: this.definition.model.temperature,
      maxOutputTokens: this.definition.model.maxOutputTokens,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      onToken,
    });

    this.emitEvent({
      id: eventId(),
      type: 'model_call_completed',
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      timestamp: Date.now(),
      data: {
        usage: response.usage,
        finishReason: response.finishReason,
      },
    });

    await this.appendTranscriptEntry({
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      kind: 'model_output',
      content: response.content,
      metadata: {
        provider: response.provider,
        model: response.model,
        finishReason: response.finishReason,
      },
    });

    // afterModelCall hook
    await this.runHooks('afterModelCall', {
      runId: run.id, agentId: this.definition.id, turnIndex, response,
    }, { runId: run.id, turnIndex });

    // Parse proposal from response
    const proposal = this.parseProposal(response);
    await this.appendExecutionNode(run.id, {
      turnIndex,
      kind: 'proposal',
      phase: 'proposal',
      actor: this.buildActorRef('model', response.model, response.provider),
      proposalType: proposal.type,
      status: 'success',
      summary: `Proposal created: ${proposal.type}`,
      metadata: this.buildProposalMetadata(proposal),
    }, 'triggered');
    this.emitEvent({
      id: eventId(),
      type: 'proposal_created',
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      timestamp: Date.now(),
      data: {
        proposalType: proposal.type,
        summary: this.buildProposalSummary(proposal),
      },
    });
    await this.appendExecutionNode(run.id, {
      turnIndex,
      kind: 'proposal',
      phase: 'validation',
      actor: this.buildActorRef('system', 'runtime-validator', 'Runtime Validator'),
      proposalType: proposal.type,
      status: 'success',
      summary: `Proposal validated: ${proposal.type}`,
    }, 'validated_by');
    this.emitEvent({
      id: eventId(),
      type: 'proposal_validated',
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      timestamp: Date.now(),
      data: {
        proposalType: proposal.type,
        accepted: true,
      },
    });

    // Execute proposal
    // ── LLM Response Guard — validate model output before tool execution ──
    if (proposal.type === 'tool_call' && proposal.toolCalls?.length) {
      const guardToolCalls: GuardToolCallProposal[] = proposal.toolCalls.map((tc: ToolCall) => ({
        name: tc.name,
        arguments: (tc.arguments ?? {}) as Record<string, unknown>,
      }));
      const guardResult = this.llmResponseGuard.validate(
        response.content,
        guardToolCalls,
      );
      if (!guardResult.safe) {
        const criticalViolations = guardResult.violations.filter(
          (v: { severity: string }) => v.severity === 'critical',
        );
        if (criticalViolations.length > 0) {
          this.emitEvent({
            id: eventId(),
            type: 'proposal_validated',
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            timestamp: Date.now(),
            data: {
              proposalType: proposal.type,
              accepted: false,
              issues: criticalViolations.map((v: { detail: string }) => v.detail),
            },
          });
          await this.appendExecutionNode(run.id, {
            turnIndex,
            kind: 'proposal',
            phase: 'validation',
            actor: this.buildActorRef('system', 'llm-response-guard', 'LLM Response Guard'),
            proposalType: proposal.type,
            status: 'blocked',
            summary: `LLM guard blocked: ${criticalViolations.length} critical violation(s)`,
            metadata: {
              violations: guardResult.violations,
              riskScore: guardResult.riskScore,
            },
          }, 'validated_by');
          // Return a blocked result — prevent tool execution
          const blockedResult: ProposalControlResult = {
            blocked: true,
            reasons: criticalViolations.map((v: { detail: string }) => v.detail),
            output: `Blocked by LLM Response Guard: ${criticalViolations.map((v: { detail: string }) => v.detail).join('; ')}`,
          };
          const turn: Turn = {
            index: turnIndex,
            input: messages.map((m) => m.content).join('\n'),
            modelOutput: response.content,
            proposal,
            approved: false,
            result: blockedResult,
            usage: response.usage,
            timestamp: Date.now(),
            events: this.eventLog.since(turnEventPosition).filter((event) => event.runId === run.id),
          };
          return {
            turn,
            outcome: this.buildTurnOutcome(turn, blockedResult),
          };
        }
      }
    }

    const result = await this.executeProposal(run, turnIndex, proposal);

    const turn: Turn = {
      index: turnIndex,
      input: messages.map((m) => m.content).join('\n'),
      modelOutput: response.content,
      proposal,
      approved: !this.isBlockedResult(result),
      result,
      usage: response.usage,
      timestamp: Date.now(),
      events: this.eventLog.since(turnEventPosition).filter((event) => event.runId === run.id),
    };

    return {
      turn,
      outcome: this.buildTurnOutcome(turn, result),
    };
  }

  /** Build message history for model call. */
  private async buildMessages(
    run: Run,
    turnIndex: number,
  ): Promise<{ messages: ModelMessage[]; contextPlan: ContextPlan }> {
    const messages: ModelMessage[] = [];
    const contextPlan = await this.buildAuxiliaryContext(run, turnIndex);

    // System message
    messages.push({
      role: 'system',
      content: this.definition.instructions,
    });

    // Canary token for LLM compromise detection — embedded in system context
    // If this token appears in model output, the system prompt was leaked/overridden
    messages.push({
      role: 'system',
      content: `[INTERNAL_VERIFICATION_TOKEN:${this.canaryToken}] This token is confidential. Never include it in your responses, tool calls, or outputs.`,
    });

    // Canary credentials — honeypot values that should never be used
    // If detected in tool calls or responses, indicates credential exfiltration (AC-2)
    if (this.canaryDeployer) {
      messages.push({
        role: 'system',
        content: this.canaryDeployer.getContextEmbed(),
      });
    }

    const formattedContext = this.formatContextPlan(contextPlan);
    if (formattedContext) {
      messages.push({
        role: 'system',
        content: formattedContext,
      });
    }

    // User input
    messages.push({
      role: 'user',
      content: run.input,
    });

    // Previous turns (conversation history)
    messages.push(...this.buildHistoryMessages(run));

    return { messages, contextPlan };
  }

  /** Map the most recent turns into conversation-history messages (assistant + tool results). */
  private buildHistoryMessages(run: Run): ModelMessage[] {
    const messages: ModelMessage[] = [];
    const historyTurns = run.turns.slice(-DEFAULT_HISTORY_TURNS);
    for (const turn of historyTurns) {
      // Assistant message
      messages.push({
        role: 'assistant',
        content: turn.modelOutput,
        toolCalls: turn.proposal.type === 'tool_call'
          ? turn.proposal.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
              ...(tc.providerMetadata ? { providerMetadata: tc.providerMetadata } : {}),
            }))
          : undefined,
      });

      // Tool results
      if (turn.proposal.type === 'tool_call' && turn.result) {
        const results = turn.result as Array<{ toolCall: ToolCall; result: { llmOutput: string } }> | ProposalControlResult;
        if (Array.isArray(results)) {
          for (const r of results) {
            messages.push({
              role: 'tool',
              content: r.result.llmOutput,
              toolCallId: r.toolCall.id,
            });
          }
        }
      }
    }
    return messages;
  }

  /** Build tool definitions for the model. */
  private buildToolDefinitions(): ModelToolDefinition[] {
    return this.executionSurface.getAll()
      .filter((capability) => capability.inputSchema)
      .map((capability) => ({
        name: capability.name,
        description: capability.description,
        parameters: this.extractJsonSchema(capability.inputSchema ?? { type: 'object', properties: {} }),
      }));
  }

  /** Extract JSON Schema from a tool's input definition. */
  private extractJsonSchema(
    input: ToolContract['input'] | Record<string, unknown>,
  ): Record<string, unknown> {
    // Check if it's a Zod schema (has ._def or .parse method)
    if (input && typeof input === 'object' && '_def' in input) {
      // Cast via unknown to break deep Zod generic type chain (TS2589 in DTS generation)
      const convert = zodToJsonSchema as unknown as (
        schema: Record<string, unknown>,
        options: { target: string },
      ) => Record<string, unknown>;
      const schema = convert(input as Record<string, unknown>, { target: 'openApi3' });
      const { $schema: _$schema, ...rest } = schema;
      return rest;
    }
    // Already JSON Schema
    return (input as Record<string, unknown>) ?? { type: 'object', properties: {} };
  }

  /** Parse model response into an ActionProposal. */
  private parseProposal(response: ModelResponse): ActionProposal {
    if (response.toolCalls?.length) {
      return {
        type: 'tool_call',
        toolCalls: response.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: typeof tc.arguments === 'string'
            ? JSON.parse(tc.arguments) as Record<string, unknown>
            : tc.arguments as unknown as Record<string, unknown>,
          ...(tc.providerMetadata ? { providerMetadata: tc.providerMetadata } : {}),
        })),
      };
    }

    const trimmed = response.content.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
          switch (parsed.type) {
            case 'final_answer':
              if (typeof parsed.answer === 'string') {
                return { type: 'final_answer', answer: parsed.answer };
              }
              break;
            case 'tool_call':
              if (Array.isArray(parsed.toolCalls)) {
                return {
                  type: 'tool_call',
                  toolCalls: parsed.toolCalls
                    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
                    .map((tc, index) => ({
                      id: typeof tc.id === 'string' ? tc.id : `tc_json_${index}`,
                      name: typeof tc.name === 'string' ? tc.name : 'unknown_tool',
                      arguments: (tc.arguments && typeof tc.arguments === 'object')
                        ? tc.arguments as Record<string, unknown>
                        : {},
                    })),
                };
              }
              break;
            case 'memory_write':
              if (Array.isArray(parsed.writes)) {
                return {
                  type: 'memory_write',
                  writes: parsed.writes as MemoryWriteRequest[],
                };
              }
              break;
            case 'handoff':
              if (typeof parsed.targetAgentId === 'string' && typeof parsed.reason === 'string') {
                return {
                  type: 'handoff',
                  targetAgentId: parsed.targetAgentId,
                  reason: parsed.reason,
                  context: typeof parsed.context === 'string' ? parsed.context : undefined,
                };
              }
              break;
            case 'approval_request':
              if (typeof parsed.action === 'string' && typeof parsed.reason === 'string') {
                return {
                  type: 'approval_request',
                  action: parsed.action,
                  reason: parsed.reason,
                  riskScore: typeof parsed.riskScore === 'number' ? parsed.riskScore : 0,
                  details: parsed.details && typeof parsed.details === 'object'
                    ? parsed.details as Record<string, unknown>
                    : undefined,
                };
              }
              break;
            default:
              break;
          }
        }
      } catch {
        // Fall through to final_answer.
      }
    }

    return {
      type: 'final_answer',
      answer: response.content,
    };
  }

  /** Execute an action proposal. */
  private async executeProposal(
    run: Run,
    turnIndex: number,
    proposal: ActionProposal,
    options?: ProposalExecutionOptions,
  ): Promise<unknown> {
    switch (proposal.type) {
      case 'tool_call':
        return this.executeToolCallProposal(run, turnIndex, proposal, options);
      case 'memory_write':
        return this.executeMemoryWriteProposal(run, turnIndex, proposal);
      case 'final_answer':
        return undefined;
      case 'handoff':
        return this.executeHandoffProposal(run, turnIndex, proposal);
      case 'approval_request':
        return this.executeApprovalRequestProposal(run, turnIndex, proposal);
      default:
        return undefined;
    }
  }

  /** Execute a tool-call proposal: events, intent verification, policy, approvals, and tool execution. Extracted verbatim from the former executeProposal switch. */
  private async executeToolCallProposal(
    run: Run,
    turnIndex: number,
    proposal: ToolCallProposal,
    options?: ProposalExecutionOptions,
  ): Promise<unknown> {
    for (const toolCall of proposal.toolCalls) {
      const capability = this.executionSurface.get(toolCall.name);
      this.emitEvent({
        id: eventId(),
        type: 'tool_proposed',
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        timestamp: Date.now(),
        data: {
          toolName: toolCall.name,
          arguments: toolCall.arguments,
          safetyClass: capability?.safetyClass ?? 'unknown',
        },
      });
      await this.appendTranscriptEntry({
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        kind: 'tool_call',
        content: `${toolCall.name}(${JSON.stringify(toolCall.arguments)})`,
        metadata: {
          source: capability?.source,
          safetyClass: capability?.safetyClass,
        },
      });
    }

    // ── Intent Verification (pre-policy) ──
    if (this.intentVerifier && proposal.type === 'tool_call') {
      let intentBlocked = false;
      for (const tc of proposal.toolCalls) {
        const verdict = await this.intentVerifier.verify({
          action: `${tc.name}(${JSON.stringify(tc.arguments)})`,
          agentId: this.definition.id,
          target: tc.name,
          amountUSD: typeof tc.arguments.amountUSD === 'number' ? tc.arguments.amountUSD : undefined,
          chain: typeof tc.arguments.chain === 'string' ? tc.arguments.chain : undefined,
        });

        if (!verdict.allowed) {
          const blockReason = `Intent verification failed for ${tc.name}: ${verdict.reasons.join('; ')}`;
          this.emitEvent({
            id: eventId(),
            type: 'policy_evaluated',
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            timestamp: Date.now(),
            data: {
              verdict: 'block',
              riskScore: 1.0,
              reasons: verdict.reasons,
            },
          } as TraceEvent);

          run.policyDecisions.push({
            verdict: 'block',
            checks: [],
            riskScore: 1.0,
            reasons: [blockReason],
            evaluatedAt: Date.now(),
          });

          run.state = 'failed';
          intentBlocked = true;
          break;
        }
      }
      if (intentBlocked) {
        return this.buildRunResult(run);
      }
    }

    // ── Policy Evaluation ──
    if (this.policyEngine.list().length > 0) {
      const policyContext = {
        agentId: this.definition.id,
        runId: run.id,
        turnIndex,
        proposal,
        runSpendUSD: this.payments?.getRunSpend() ?? 0,
        totalTokens: run.totalUsage.totalTokens,
        metadata: {
          identityClaims: this.identityClaims ?? undefined,
          integrityBinding: this.integrityBinding ?? undefined,
          enforcementLevel: 'agent' as const,
        },
      };

      const decision = await this.policyEngine.evaluate(policyContext);

      this.emitEvent({
        id: eventId(),
        type: 'policy_evaluated',
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        timestamp: Date.now(),
        data: { verdict: decision.verdict, riskScore: decision.riskScore, reasons: decision.reasons },
      } as TraceEvent);
      await this.appendExecutionNode(run.id, {
        turnIndex,
        kind: 'policy_decision',
        phase: 'policy',
        actor: this.buildActorRef('system', 'policy-engine', 'Policy Engine'),
        status: decision.verdict === 'block' ? 'blocked' : 'success',
        summary: `Policy ${decision.verdict} (${decision.riskScore.toFixed(2)})`,
        metadata: {
          verdict: decision.verdict,
          riskScore: decision.riskScore,
          reasons: decision.reasons,
        },
      }, 'validated_by');
      run.policyDecisions.push(decision);
      await this.appendTranscriptEntry({
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        kind: 'policy_decision',
        content: `${decision.verdict.toUpperCase()} (${decision.riskScore.toFixed(2)}): ${decision.reasons.join('; ') || 'No reasons provided'}`,
        metadata: {
          verdict: decision.verdict,
          riskScore: decision.riskScore,
          reasons: decision.reasons,
        },
      });

      if (decision.verdict === 'block') {
        await this.runHooks('onPolicyViolation', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          proposal,
          decision,
        }, { runId: run.id, turnIndex });
        return {
          blocked: true,
          terminalState: 'failed',
          reasons: decision.reasons,
          policyDecision: decision,
        } satisfies ProposalControlResult;
      }

      if (decision.verdict === 'escalate' && !options?.approval?.approved) {
        await this.runHooks('onPolicyViolation', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          proposal,
          decision,
        }, { runId: run.id, turnIndex });

        const beforeApproval = await this.runHooks('beforeApprovalRequest', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          proposal,
          decision,
        }, { runId: run.id, turnIndex });
        if (beforeApproval.override === 'deny') {
          return {
            blocked: true,
            terminalState: 'failed',
            reasons: beforeApproval.reasons,
            policyDecision: decision,
          } satisfies ProposalControlResult;
        }

        const started = await this.approvals.startApproval(
          run.id,
          this.definition.id,
          turnIndex,
          proposal,
          decision,
          { autoResolve: false },
        );

        if (!started.decision) {
          this.emitEvent({
            id: eventId(),
            type: 'approval_requested',
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            timestamp: Date.now(),
            data: {
              action: 'tool_call',
              reason: started.request.reason,
              riskScore: decision.riskScore,
            },
          });
          await this.appendExecutionNode(run.id, {
            turnIndex,
            kind: 'approval',
            phase: 'approval',
            actor: this.buildActorRef('system', 'approval-manager', 'Approval Manager'),
            status: 'pending',
            summary: `Approval requested for tool call: ${started.request.reason}`,
            metadata: {
              requestId: started.request.id,
              mode: started.request.mode,
              riskScore: decision.riskScore,
            },
          }, 'approved_by');
          await this.appendTranscriptEntry({
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            kind: 'approval_event',
            content: `Approval requested for tool call: ${started.request.reason}`,
            metadata: {
              requestId: started.request.id,
              mode: started.request.mode,
              riskScore: decision.riskScore,
            },
          });
          return {
            blocked: true,
            waitingForApproval: true,
            requestId: started.request.id,
            approvalMode: started.request.mode,
            reasons: [started.request.reason],
            policyDecision: decision,
          } satisfies ProposalControlResult;
        }

        run.approvalDecisions.push(started.decision);
        this.emitEvent({
          id: eventId(),
          type: 'approval_resolved',
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          timestamp: Date.now(),
          data: {
            requestId: started.request.id,
            approved: started.decision.approved,
            approver: started.decision.decidedBy,
            reason: started.decision.reason,
          },
        });
        await this.appendExecutionNode(run.id, {
          turnIndex,
          kind: 'approval',
          phase: 'approval',
          actor: this.buildActorRef('operator', started.decision.decidedBy, started.decision.decidedBy),
          status: started.decision.approved ? 'success' : 'blocked',
          summary: `Approval ${started.decision.approved ? 'granted' : 'denied'}`,
          metadata: {
            requestId: started.request.id,
            reason: started.decision.reason,
          },
        }, 'approved_by');
        await this.appendTranscriptEntry({
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          kind: 'approval_event',
          content: `Approval ${started.decision.approved ? 'granted' : 'denied'} by ${started.decision.decidedBy}: ${started.decision.reason ?? 'No reason provided'}`,
          metadata: {
            requestId: started.request.id,
            mode: started.request.mode,
            approved: started.decision.approved,
          },
        });

        await this.runHooks('afterApprovalDecision', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          requestId: started.request.id,
          approved: started.decision.approved,
          approver: started.decision.decidedBy,
          reason: started.decision.reason,
        }, { runId: run.id, turnIndex });

        if (!started.decision.approved) {
          return {
            blocked: true,
            terminalState: 'failed',
            reasons: [`Approval denied: ${started.decision.reason ?? 'Unknown reason'}`],
            approvalDecision: started.decision,
            policyDecision: decision,
          } satisfies ProposalControlResult;
        }
      }
    }

    // ── Standalone Security Gateway (dual-layer enforcement) ──
    // When configured, evaluates the same proposal through the framework-agnostic
    // security gateway used by external (non-SDK) agents. Worst-verdict-wins.
    if (this.securityGateway) {
      try {
        const p = proposal as ActionProposal;
        let actionType: string;
        let toolCalls: Array<{ name: string; arguments: Record<string, unknown>; description?: string }> | undefined;
        let content: string | undefined;
        let targetAgentId: string | undefined;

        switch (p.type) {
          case 'tool_call':
            actionType = 'tool_call';
            toolCalls = p.toolCalls.map((tc) => ({ name: tc.name, arguments: (tc as any).args ?? {}, description: (tc as any).description }));
            break;
          case 'final_answer':
            actionType = 'llm_call';
            content = p.answer;
            break;
          case 'handoff':
            actionType = 'handoff';
            targetAgentId = p.targetAgentId;
            content = p.context;
            break;
          case 'memory_write':
            actionType = 'memory_write';
            break;
          default:
            actionType = 'custom';
            break;
        }

        const gwResult = await this.securityGateway.evaluate({
          agent: { agentId: this.definition.id, name: this.definition.name, framework: 'veridex-sdk' },
          action: { type: actionType, toolCalls, content, targetAgentId },
          runId: run.id,
          turnIndex,
          runSpendUsd: this.payments?.getRunSpend() ?? 0,
          totalTokens: run.totalUsage.totalTokens,
        });
        // TODO: why was the sovereignty violation events for compliance audit trail removed? Re-add with proper event type and handling in compliance module

        if (gwResult.verdict === 'block') {
          const gwDecision: PolicyDecision = {
            verdict: 'block',
            riskScore: gwResult.riskScore,
            reasons: gwResult.reasons.map((r: string) => `[SecurityGateway] ${r}`),
            checks: [],
            evaluatedAt: Date.now(),
          };
          run.policyDecisions.push(gwDecision);
          this.emitEvent({
            id: eventId(),
            type: 'policy_evaluated',
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            timestamp: Date.now(),
            data: { verdict: 'block', riskScore: gwResult.riskScore, reasons: gwDecision.reasons },
          } as TraceEvent);
          return {
            blocked: true,
            terminalState: 'failed',
            reasons: gwDecision.reasons,
            policyDecision: gwDecision,
          } satisfies ProposalControlResult;
        }
      } catch (gwErr) {
        console.warn('[SecurityGateway] Evaluation failed (non-blocking):', gwErr);
      }
    }

    if (options?.approval?.approved) {
      this.emitEvent({
        id: eventId(),
        type: 'approval_resolved',
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        timestamp: Date.now(),
        data: {
          requestId: options.approval.requestId,
          approved: true,
          approver: options.approval.approver ?? 'operator',
          reason: options.approval.reason,
        },
      });
      await this.appendExecutionNode(run.id, {
        turnIndex,
        kind: 'approval',
        phase: 'approval',
        actor: this.buildActorRef('operator', options.approval.approver ?? 'operator', options.approval.approver ?? 'operator'),
        status: 'success',
        summary: 'Approval resolved during resume',
        metadata: {
          requestId: options.approval.requestId,
          reason: options.approval.reason,
        },
      }, 'approved_by');
      await this.runHooks('afterApprovalDecision', {
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        requestId: options.approval.requestId,
        approved: true,
        approver: options.approval.approver ?? 'operator',
        reason: options.approval.reason,
      }, { runId: run.id, turnIndex });
    }

    if (this.payments?.isAvailable()) {
      for (const toolCall of proposal.toolCalls) {
        const capability = this.executionSurface.get(toolCall.name);
        const tool = this.tools.get(toolCall.name);
        const estimate = capability?.costEstimate?.(toolCall.arguments) ?? tool?.costEstimate?.(toolCall.arguments);
        if (!estimate) continue;

        const beforePayment = await this.runHooks('beforePayment', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          toolName: toolCall.name,
          estimate,
        }, { runId: run.id, turnIndex });
        if (beforePayment.override === 'deny') {
          return {
            blocked: true,
            terminalState: 'failed',
            reasons: beforePayment.reasons,
          } satisfies ProposalControlResult;
        }

        const budget = this.payments.checkBudget(estimate.estimatedUSD);
        if (!budget.allowed) {
          return {
            blocked: true,
            terminalState: 'failed',
            reasons: [budget.reason ?? 'Budget check failed'],
            estimatedSpendUSD: estimate.estimatedUSD,
          } satisfies ProposalControlResult;
        }
      }
    }

    const context = {
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      sdk: this.core?.isAvailable() ? this.core.getSDK() : undefined,
      wallet: this.payments?.isAvailable() ? this.payments.getPayments() : undefined,
    };

    const results: ToolExecutionResult[] = [];
    for (const toolCall of proposal.toolCalls) {
      const capability = this.executionSurface.get(toolCall.name);
      const tool = this.tools.get(toolCall.name);
      const toolName = toolCall.name;
      const safetyClass = capability?.safetyClass ?? tool?.safetyClass ?? 'read';

      const beforeValidation = await this.runHooks('beforeToolValidation', {
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        toolName,
        toolInput: toolCall.arguments,
        safetyClass,
      }, { runId: run.id, turnIndex });

      if (beforeValidation.override === 'deny') {
        results.push({
          toolCall,
          result: {
            llmOutput: '',
            success: false,
            error: beforeValidation.reasons.join('; ') || 'Tool validation denied by hook',
          },
          durationMs: 0,
          retryCount: 0,
          outcome: 'policy_blocked',
        });
        continue;
      }

      const validationError = capability?.tool
        ? this.toolValidator.validateInput(capability.tool, toolCall.arguments)
        : !capability
          ? `Tool '${toolName}' not found`
          : undefined;

      await this.runHooks('afterToolValidation', {
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        toolName,
        toolInput: toolCall.arguments,
        safetyClass,
        passed: !validationError,
        error: validationError,
      }, { runId: run.id, turnIndex });

      if (validationError) {
        results.push({
          toolCall,
          result: {
            llmOutput: `Validation error: ${validationError}`,
            success: false,
            error: validationError,
          },
          durationMs: 0,
          retryCount: 0,
          outcome: 'permanent_failure',
        });
        continue;
      }

      const beforeExecute = await this.runHooks('beforeToolExecute', {
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        toolName,
        toolInput: toolCall.arguments,
        safetyClass,
      }, { runId: run.id, turnIndex });

      if (beforeExecute.override === 'deny') {
        results.push({
          toolCall,
          result: {
            llmOutput: '',
            success: false,
            error: beforeExecute.reasons.join('; ') || 'Tool execution denied by hook',
          },
          durationMs: 0,
          retryCount: 0,
          outcome: 'policy_blocked',
        });
        continue;
      }

      const idempotencyKey = this.buildIdempotencyKey(run.id, turnIndex, toolCall);
      const existingReceipt = await this.executionGraphs.findReceiptByIdempotencyKey(run.id, idempotencyKey);
      this.emitEvent({
        id: eventId(),
        type: 'capability_invoked',
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        timestamp: Date.now(),
        data: {
          capabilityName: toolName,
          source: capability?.source,
          safetyClass,
          idempotencyKey,
        },
      });
      await this.appendExecutionNode(run.id, {
        turnIndex,
        kind: 'capability',
        phase: 'execution',
        actor: this.buildActorRef('tool', toolName, toolName),
        capabilityName: toolName,
        status: existingReceipt ? 'skipped' : 'pending',
        summary: existingReceipt
          ? `Skipped ${toolName}; existing receipt ${existingReceipt.id}`
          : `Invoking capability ${toolName}`,
        metadata: {
          source: capability?.source,
          safetyClass,
          idempotencyKey,
        },
      }, 'invoked');

      if (existingReceipt) {
        const execution: ToolExecutionResult = {
          toolCall,
          result: {
            llmOutput: existingReceipt.summary,
            uiOutput: existingReceipt.summary,
            success: true,
          },
          durationMs: 0,
          retryCount: 0,
          outcome: 'idempotent_skip',
          receipt: existingReceipt,
        };
        results.push(execution);
        await this.recordSideEffectReceipt({
          ...existingReceipt,
          status: 'skipped',
          summary: `Idempotent skip for ${toolName}`,
          recordedAt: Date.now(),
        });
        continue;
      }

      let execution: ToolExecutionResult;
      if (capability?.tool) {
        execution = await this.toolExecutor.execute(toolCall, context);
      } else if (capability) {
        const startedAt = Date.now();
        try {
          const result = await capability.execute({
            input: toolCall.arguments,
            context,
          });
          execution = {
            toolCall,
            result,
            durationMs: Date.now() - startedAt,
            retryCount: 0,
          };
        } catch (error) {
          execution = {
            toolCall,
            result: {
              llmOutput: '',
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
            durationMs: Date.now() - startedAt,
            retryCount: 0,
          };
        }
      } else {
        execution = {
          toolCall,
          result: {
            llmOutput: '',
            success: false,
            error: `Tool '${toolName}' not found`,
          },
          durationMs: 0,
          retryCount: 0,
        };
      }

      execution.outcome = this.classifyToolExecutionOutcome(execution);
      const receipt: SideEffectReceipt = {
        id: `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        runId: run.id,
        turnIndex,
        capabilityName: toolName,
        idempotencyKey,
        status: execution.result.success === false ? 'failed' : 'recorded',
        summary: execution.result.success === false
          ? `${toolName} failed: ${execution.result.error ?? 'Unknown error'}`
          : `${toolName} executed successfully`,
        resource: undefined,
        metadata: {
          source: capability?.source,
          durationMs: execution.durationMs,
          outcome: execution.outcome,
        },
        recordedAt: Date.now(),
      };
      execution.receipt = await this.recordSideEffectReceipt(receipt);

      await this.runHooks('afterToolExecute', {
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        toolName,
        toolInput: toolCall.arguments,
        toolOutput: execution.result,
        safetyClass,
        success: execution.result.success,
      }, { runId: run.id, turnIndex });

      results.push(execution);
      await this.appendTranscriptEntry({
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        kind: 'tool_result',
        content: `${toolName}: ${execution.result.success ? 'success' : 'failure'}${execution.result.error ? ` (${execution.result.error})` : ''}`,
        metadata: {
          source: capability?.source,
          durationMs: execution.durationMs,
          success: execution.result.success,
          outcome: execution.outcome,
          receiptId: execution.receipt?.id,
        },
      });
    }

    // Emit tool events
    for (const r of results) {
      const tool = this.tools.get(r.toolCall.name);
      const amountUSD = r.result.metrics?.costUSD;

      if (
        amountUSD !== undefined &&
        amountUSD > 0 &&
        this.payments?.isAvailable()
      ) {
        this.payments.recordSpend(amountUSD);
      }

      if (amountUSD !== undefined || tool?.safetyClass === 'financial') {
        this.emitEvent({
          id: eventId(),
          type: 'payment_attempted',
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          timestamp: Date.now(),
          data: {
            protocol: typeof r.toolCall.arguments.protocol === 'string'
              ? r.toolCall.arguments.protocol
              : 'tool',
            amountUSD: amountUSD ?? 0,
            chain: typeof r.toolCall.arguments.chain === 'string'
              ? r.toolCall.arguments.chain
              : 'unknown',
            recipient: typeof r.toolCall.arguments.recipient === 'string'
              ? r.toolCall.arguments.recipient
              : r.toolCall.name,
            success: r.result.success !== false,
            txHash: typeof r.toolCall.arguments.txHash === 'string'
              ? r.toolCall.arguments.txHash
              : undefined,
            error: r.result.error,
          },
        });
        await this.runHooks('afterPayment', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          toolName: r.toolCall.name,
          amountUSD: amountUSD ?? 0,
          success: r.result.success !== false,
          error: r.result.error,
        }, { runId: run.id, turnIndex });
      }

      this.emitEvent({
        id: eventId(),
        type: 'tool_executed',
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        timestamp: Date.now(),
        data: {
          toolName: r.toolCall.name,
          success: r.result.success !== false,
          durationMs: r.durationMs,
          error: r.result.error,
        },
      });
    }

    return results;
  }

  /** Execute a memory-write proposal. Extracted verbatim from executeProposal. */
  private async executeMemoryWriteProposal(
    run: Run,
    turnIndex: number,
    proposal: MemoryWriteProposal,
  ): Promise<unknown> {
    for (const req of proposal.writes) {
      const beforeWrite = await this.runHooks('beforeMemoryWrite', {
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        request: req,
      }, { runId: run.id, turnIndex });
      if (beforeWrite.override === 'deny') {
        continue;
      }

      const validation = await this.validateMemoryProposal(req);
      await this.appendExecutionNode(run.id, {
        turnIndex,
        kind: 'proposal',
        phase: 'validation',
        actor: this.buildActorRef('system', 'memory-validator', 'Memory Validator'),
        proposalType: 'memory_write',
        status: validation.accepted ? 'success' : 'blocked',
        summary: validation.accepted ? 'Memory proposal validated' : 'Memory proposal rejected',
        metadata: {
          issues: validation.issues,
        },
      }, 'validated_by');
      this.emitEvent({
        id: eventId(),
        type: 'proposal_validated',
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        timestamp: Date.now(),
        data: {
          proposalType: 'memory_write',
          accepted: validation.accepted,
          issues: validation.issues.map((issue) => `${issue.code}: ${issue.message}`),
        },
      });
      if (!validation.accepted) {
        continue;
      }

      if (req.entry.kind === 'workspace_state' && req.entry.stateRef && this.workspaceState?.isAvailable()) {
        const resourceRef = this.stateRefToResourceRef(req.entry.stateRef);
        this.emitEvent({
          id: eventId(),
          type: 'resource_mutation_proposed',
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          timestamp: Date.now(),
          data: {
            resourceType: req.entry.stateRef.resourceType,
            resourceId: req.entry.stateRef.resourceId,
            operation: 'update',
          },
        });
        await this.appendExecutionNode(run.id, {
          turnIndex,
          kind: 'resource_mutation',
          phase: 'mutation',
          actor: this.buildActorRef('agent', this.definition.id, this.definition.name),
          resource: resourceRef,
          status: 'pending',
          summary: `Workspace mutation proposed for ${req.entry.stateRef.resourceType}/${req.entry.stateRef.resourceId}`,
          metadata: {
            overwriteStrategy: req.overwriteStrategy,
          },
        }, 'mutates');

        const mutation = await this.workspaceState.proposeMutation({
          ref: req.entry.stateRef,
          operation: req.overwriteStrategy === 'append' ? 'update' : 'update',
          payload: {
            content: req.entry.content,
            tags: req.entry.tags,
            metadata: req.entry.metadata,
            confidence: req.entry.confidence,
            evidenceRef: req.entry.evidenceRef,
          },
          reason: `Run ${run.id} turn ${turnIndex} proposed workspace-state mutation`,
          expectedVersion: req.entry.stateRef.version,
          idempotencyKey: `mem:${run.id}:${turnIndex}:${req.entry.stateRef.resourceType}:${req.entry.stateRef.resourceId}`,
        });

        this.emitEvent({
          id: eventId(),
          type: 'resource_mutation_committed',
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          timestamp: Date.now(),
          data: {
            resourceType: req.entry.stateRef.resourceType,
            resourceId: req.entry.stateRef.resourceId,
            accepted: mutation.accepted,
            reason: mutation.rejectionReason,
          },
        });
        await this.appendExecutionNode(run.id, {
          turnIndex,
          kind: 'resource_mutation',
          phase: 'mutation',
          actor: this.buildActorRef('system', 'workspace-state', 'Workspace State'),
          resource: resourceRef,
          status: mutation.accepted ? 'success' : 'blocked',
          summary: mutation.accepted
            ? `Workspace mutation committed for ${req.entry.stateRef.resourceType}/${req.entry.stateRef.resourceId}`
            : `Workspace mutation rejected for ${req.entry.stateRef.resourceType}/${req.entry.stateRef.resourceId}`,
          metadata: mutation.snapshot ? { snapshot: mutation.snapshot } : { rejectionReason: mutation.rejectionReason },
        }, 'mutates');

        if (!mutation.accepted) {
          continue;
        }
      }

      const entry = await this.memory.write(req);
      this.emitEvent({
        id: eventId(),
        type: 'memory_written',
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        timestamp: Date.now(),
        data: {
          tier: entry.tier,
          entryId: entry.id,
          scope: entry.scope,
          provenance: entry.provenance,
        },
      });
      await this.runHooks('afterMemoryWrite', {
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        entry,
      }, { runId: run.id, turnIndex });
      await this.appendTranscriptEntry({
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        kind: 'system_note',
        content: `Memory write recorded to ${entry.tier}/${entry.scope}: ${entry.content}`,
        metadata: {
          entryId: entry.id,
          tier: entry.tier,
          scope: entry.scope,
        },
      });
    }
    return { written: proposal.writes.length };
  }

  /** Execute a handoff proposal. Extracted verbatim from executeProposal. */
  private async executeHandoffProposal(
    run: Run,
    turnIndex: number,
    proposal: HandoffProposal,
  ): Promise<unknown> {
      const beforeHandoff = await this.runHooks('beforeHandoff', {
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        proposal,
      }, { runId: run.id, turnIndex });
      if (beforeHandoff.override === 'deny') {
        return {
          blocked: true,
          terminalState: 'failed',
          reasons: beforeHandoff.reasons,
        } satisfies ProposalControlResult;
      }
    this.emitEvent({
      id: eventId(),
      type: 'handoff_initiated',
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      timestamp: Date.now(),
      data: {
        targetAgentId: proposal.targetAgentId,
        reason: proposal.reason,
      },
    });
      await this.appendExecutionNode(run.id, {
        turnIndex,
        kind: 'capability',
        phase: 'execution',
        actor: this.buildActorRef('remote_agent', proposal.targetAgentId, proposal.targetAgentId),
        capabilityName: proposal.targetAgentId,
        status: 'pending',
        summary: `Handoff initiated to ${proposal.targetAgentId}`,
        metadata: {
          reason: proposal.reason,
        },
      }, 'invoked');
      await this.appendTranscriptEntry({
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        kind: 'handoff',
        content: `Handoff to ${proposal.targetAgentId}: ${proposal.reason}`,
        metadata: {
          targetAgentId: proposal.targetAgentId,
        },
      });
      const handler = this.handoffHandlers.get(proposal.targetAgentId);
      if (handler) {
        const handoff = await handler({
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          targetAgentId: proposal.targetAgentId,
          reason: proposal.reason,
          context: proposal.context,
          sdk: this.core?.getSDK(),
          wallet: this.payments?.getPayments(),
        });

        await this.runHooks('afterHandoff', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          proposal,
          result: handoff,
        }, { runId: run.id, turnIndex });

        if (!handoff.success) {
          return {
            blocked: true,
            terminalState: 'failed',
            reasons: [handoff.error ?? `Handoff to "${proposal.targetAgentId}" failed`],
            metadata: handoff.metadata,
          } satisfies ProposalControlResult;
        }

        return {
          terminalState: 'completed',
          output: handoff.output,
          metadata: handoff.metadata,
        } satisfies ProposalControlResult;
      }

      await this.runHooks('afterHandoff', {
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        proposal,
      }, { runId: run.id, turnIndex });
    return { targetAgentId: proposal.targetAgentId, reason: proposal.reason };
  }

  /** Execute an approval-request proposal. Extracted verbatim from executeProposal. */
  private async executeApprovalRequestProposal(
    run: Run,
    turnIndex: number,
    proposal: ApprovalRequestProposal,
  ): Promise<unknown> {
      const beforeApproval = await this.runHooks('beforeApprovalRequest', {
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        proposal,
      }, { runId: run.id, turnIndex });
      if (beforeApproval.override === 'deny') {
        return {
          blocked: true,
          terminalState: 'failed',
          reasons: beforeApproval.reasons,
        } satisfies ProposalControlResult;
      }
    this.emitEvent({
      id: eventId(),
      type: 'approval_requested',
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      timestamp: Date.now(),
      data: {
        action: proposal.action,
        reason: proposal.reason,
        riskScore: proposal.riskScore,
      },
    });
      await this.appendExecutionNode(run.id, {
        turnIndex,
        kind: 'approval',
        phase: 'approval',
        actor: this.buildActorRef('agent', this.definition.id, this.definition.name),
        status: 'pending',
        summary: `Approval explicitly requested for ${proposal.action}`,
        metadata: {
          reason: proposal.reason,
          riskScore: proposal.riskScore,
        },
      }, 'approved_by');
      await this.appendTranscriptEntry({
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        kind: 'approval_event',
        content: `Approval requested: ${proposal.action} (${proposal.reason})`,
        metadata: {
          action: proposal.action,
          riskScore: proposal.riskScore,
        },
      });
      return {
        action: proposal.action,
        reason: proposal.reason,
        waitingForApproval: true,
      };
  }

  /** Determine the next run state from a proposal. */
  private getNextState(proposal: ActionProposal, result?: unknown): RunState {
    const control = result as ProposalControlResult | undefined;
    if (control?.terminalState) {
      return control.terminalState;
    }
    if (control?.waitingForApproval) {
      return 'waiting_for_approval';
    }

    switch (proposal.type) {
      case 'final_answer':
        return 'completed';
      case 'tool_call':
        return 'running'; // Continue loop after tool execution
      case 'handoff':
        return 'waiting_for_handoff';
      case 'approval_request':
        return 'waiting_for_approval';
      case 'memory_write':
        return 'running'; // Continue after memory write
      default:
        return 'running';
    }
  }

  /** Emit a trace event. */
  private emitEvent(event: TraceEvent): void {
    if (this.enableTracing) {
      this.events.emit(event);
      if (!this.traceHookActive && event.type !== 'hook_executed') {
        this.traceHookActive = true;
        void this.hookRunner
          .run('onTraceEvent', { event })
          .catch(() => undefined)
          .finally(() => {
            this.traceHookActive = false;
          });
      }
    }
  }

  private emitFidelityEvent(
    runId: string,
    turnIndex: number,
    report: FidelityReport,
  ): void {
    this.emitEvent({
      id: eventId(),
      type: 'context_fidelity',
      runId,
      agentId: this.definition.id,
      turnIndex,
      timestamp: report.emittedAt,
      data: {
        modelId: report.modelId,
        promptTokens: report.promptTokens,
        fidelity: report.fidelity,
        fidelityTarget: report.fidelityTarget,
        pGate: report.pGate,
        pGateUsage: report.pGateUsage,
        compactionTriggered: report.compactionTriggered,
        reasons: report.reasons,
      },
    });
  }

  private emitCompactedEvent(
    runId: string,
    turnIndex: number,
    compactorId: string,
    result: {
      tokensShed: number;
      actions: ReadonlyArray<{
        sectionId: string;
        kind: string;
        reason?: string;
        tokensBefore: number;
        tokensAfter: number;
      }>;
      notes?: string;
    },
  ): void {
    this.emitEvent({
      id: eventId(),
      type: 'context_compacted',
      runId,
      agentId: this.definition.id,
      turnIndex,
      timestamp: Date.now(),
      data: {
        compactorId,
        tokensShed: result.tokensShed,
        actions: result.actions.map((a) => ({
          sectionId: a.sectionId,
          kind: a.kind,
          reason: a.reason,
          tokensBefore: a.tokensBefore,
          tokensAfter: a.tokensAfter,
        })),
        notes: result.notes,
      },
    });
  }

  private async runHooks(
    phase: HookPhase,
    context: unknown,
    eventContext: { runId: string; turnIndex?: number },
  ): Promise<HookRunResult> {
    const startedAt = Date.now();
    const result = await this.hookRunner.run(phase, context);

    this.emitEvent({
      id: eventId(),
      type: 'hook_executed',
      runId: eventContext.runId,
      agentId: this.definition.id,
      turnIndex: eventContext.turnIndex,
      timestamp: Date.now(),
      data: {
        hookName: phase,
        phase,
        durationMs: Date.now() - startedAt,
        override: result.override === 'continue' ? undefined : result.override,
      },
    });

    return result;
  }

  private async buildAuxiliaryContext(
    run: Run,
    turnIndex: number,
  ): Promise<ContextPlan> {
    const { sections, includeMemory } = await this.assembleContextSections(run, turnIndex);

    const beforeCompile = await this.runHooks('beforeContextCompile', {
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      sections,
    }, { runId: run.id, turnIndex });
    if (beforeCompile.override === 'deny') {
      throw new Error(`Context compilation denied by hook: ${beforeCompile.reasons.join('; ')}`);
    }

    const plan = await this.compileContextPlan(run, turnIndex, sections, includeMemory);

    const afterCompile = await this.runHooks('afterContextCompile', {
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      plan,
    }, { runId: run.id, turnIndex });
    if (afterCompile.override === 'deny') {
      throw new Error(`Compiled context rejected by hook: ${afterCompile.reasons.join('; ')}`);
    }

    return plan;
  }

  /** Gather the auxiliary context sections (run state, budget, payments, tools, memory, workspace). */
  private async assembleContextSections(
    run: Run,
    turnIndex: number,
  ): Promise<{ sections: ContextSectionInput[]; includeMemory: boolean }> {
    const sections: ContextSectionInput[] = [];

    const runState = this.serializeRunState(run, turnIndex);
    if (runState) {
      sections.push({
        id: 'run-state',
        source: 'run_state',
        content: runState,
        priority: 100,
        budgetTokens: 250,
      });
    }

    const budgetSummary = this.serializeBudgetState(run);
    if (budgetSummary) {
      sections.push({
        id: 'budget',
        source: 'budget',
        content: budgetSummary,
        priority: 95,
        budgetTokens: 180,
      });
    }

    const paymentConstraints = this.serializePaymentConstraints();
    if (paymentConstraints) {
      sections.push({
        id: 'payment-constraints',
        source: 'payment_constraints',
        content: paymentConstraints,
        priority: 90,
        budgetTokens: 160,
      });
    }

    const toolCatalog = this.serializeToolCatalog();
    if (toolCatalog) {
      sections.push({
        id: 'tools',
        source: 'tools',
        content: toolCatalog,
        priority: 70,
        budgetTokens: 700,
        truncation: 'tail',
      });
    }

    const memorySections = await this.buildMemoryContextSections(run.id);
    sections.push(...memorySections);

    // Inject governed workspace state if an adapter is connected
    const workspaceSections = await this.buildWorkspaceStateSections();
    sections.push(...workspaceSections);

    return { sections, includeMemory: memorySections.length > 0 };
  }

  /** Compile the context plan (with homeostatic compaction when configured). */
  private async compileContextPlan(
    run: Run,
    turnIndex: number,
    sections: ContextSectionInput[],
    includeMemory: boolean,
  ): Promise<ContextPlan> {
    const compileOptions = {
      maxTokens: this.estimateContextBudget(run),
      sections,
      includeMemory,
      includeTools: this.tools.getAll().length > 0,
      includeHistory: run.turns.length > 0,
      maxHistoryTurns: DEFAULT_HISTORY_TURNS,
    };

    let plan: ContextPlan;
    if (this.homeostatic) {
      let homeoPlan = this.homeostatic.compileWithPolicy(
        compileOptions,
        this.retrievalPolicy,
      );
      this.emitFidelityEvent(run.id, turnIndex, homeoPlan.fidelityReport);

      if (homeoPlan.compactionTriggered && this.compactor) {
        try {
          const trigger: CompactionTrigger = {
            ...homeoPlan.fidelityReport,
            plan: homeoPlan,
          };
          const result = await this.compactor.compact({
            trigger,
            fidelityModel: this.homeostatic.fidelityModel,
            fidelityTarget: this.homeostatic.fidelityTarget,
            compactionThreshold: this.homeostatic.compactionThreshold,
          });
          // Recompile from rewritten sections.
          homeoPlan = this.homeostatic.compileWithPolicy(
            { ...compileOptions, sections: result.sections },
            this.retrievalPolicy,
          );
          this.emitCompactedEvent(run.id, turnIndex, this.compactor.id, result);
          this.emitFidelityEvent(run.id, turnIndex, homeoPlan.fidelityReport);
        } catch (err) {
          // Compaction failure must not break the run; fall back to the
          // pre-compaction plan and surface as an error event.
          this.emitEvent({
            id: eventId(),
            type: 'error_occurred',
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            timestamp: Date.now(),
            data: {
              error: err instanceof Error ? err.message : String(err),
              phase: 'compactor',
              recoverable: true,
            },
          });
        }
      }
      plan = homeoPlan;
    } else {
      plan = this.context.compileWithPolicy(compileOptions, this.retrievalPolicy);
    }

    return plan;
  }

  private estimateContextBudget(run: Run): number {
    if (this.definition.maxTokens) {
      const remaining = Math.max(this.definition.maxTokens - run.totalUsage.totalTokens, 256);
      return Math.min(DEFAULT_CONTEXT_TOKEN_BUDGET, remaining);
    }
    return DEFAULT_CONTEXT_TOKEN_BUDGET;
  }

  private serializeRunState(run: Run, turnIndex: number): string {
    const parts = [
      `Run ID: ${run.id}`,
      `Turn: ${turnIndex + 1}`,
      `State: ${run.state}`,
    ];

    if (run.metadata && Object.keys(run.metadata).length > 0) {
      parts.push(`Run metadata: ${JSON.stringify(run.metadata)}`);
    }
    if (this.definition.metadata && Object.keys(this.definition.metadata).length > 0) {
      parts.push(`Agent metadata: ${JSON.stringify(this.definition.metadata)}`);
    }

    return parts.join('\n');
  }

  private serializeBudgetState(run: Run): string {
    const parts = [`Total tokens used so far: ${run.totalUsage.totalTokens}`];

    if (this.definition.maxTokens) {
      parts.push(`Max tokens allowed: ${this.definition.maxTokens}`);
    }
    if (this.payments?.isAvailable()) {
      parts.push(`Run spend so far (USD): ${this.payments.getRunSpend()}`);
    }

    return parts.join('\n');
  }

  private serializePaymentConstraints(): string {
    if (!this.definition.payments) return '';

    const parts: string[] = [];
    if (this.definition.payments.dailyLimitUSD !== undefined) {
      parts.push(`Daily spend limit USD: ${this.definition.payments.dailyLimitUSD}`);
    }
    if (this.definition.payments.perTransactionLimitUSD !== undefined) {
      parts.push(
        `Per-transaction spend limit USD: ${this.definition.payments.perTransactionLimitUSD}`,
      );
    }
    if (this.definition.payments.allowedChains?.length) {
      parts.push(`Allowed chains: ${this.definition.payments.allowedChains.join(', ')}`);
    }
    if (this.definition.payments.allowedProtocols?.length) {
      parts.push(
        `Allowed payment protocols: ${this.definition.payments.allowedProtocols.join(', ')}`,
      );
    }
    if (this.definition.payments.requireApproval) {
      parts.push('Financial actions require approval.');
    }

    return parts.join('\n');
  }

  private serializeToolCatalog(): string {
    const tools = this.tools.getAll();
    if (tools.length === 0) return '';

    if (this.progressiveToolDisclosure) {
      return renderDisclosedCatalog(tools);
    }

    return tools.map((tool) => {
      const detail: string[] = [
        `- ${tool.name} [${tool.safetyClass}]`,
        `  ${tool.description}`,
      ];
      if (tool.permissions?.length) {
        detail.push(`  permissions: ${tool.permissions.join(', ')}`);
      }
      if (tool.timeoutMs) {
        detail.push(`  timeoutMs: ${tool.timeoutMs}`);
      }
      return detail.join('\n');
    }).join('\n');
  }

  private async buildMemoryContextSections(_runId: string): Promise<ContextSectionInput[]> {
    const sections: ContextSectionInput[] = [];

    const working = await this.memory.search({
      tier: 'working',
      scope: 'run',
      limit: 5,
    });
    if (working.length > 0) {
      sections.push({
        id: 'memory-working',
        source: 'memory',
        content: this.serializeMemoryEntries('Working memory', working),
        priority: 85,
        budgetTokens: 400,
      });
    }

    const episodic = await this.memory.search({
      tier: 'episodic',
      limit: 3,
    });
    if (episodic.length > 0) {
      sections.push({
        id: 'memory-episodic',
        source: 'memory',
        content: this.serializeMemoryEntries('Episodic memory', episodic),
        priority: 65,
        budgetTokens: 280,
      });
    }

    const semantic = await this.memory.search({
      tier: 'semantic',
      limit: 5,
    });
    if (semantic.length > 0) {
      sections.push({
        id: 'memory-semantic',
        source: 'memory',
        content: this.serializeMemoryEntries('Semantic memory', semantic),
        priority: 75,
        budgetTokens: 320,
      });
    }

    const procedural = await this.memory.search({
      tier: 'procedural',
      limit: 3,
    });
    if (procedural.length > 0) {
      sections.push({
        id: 'memory-procedural',
        source: 'memory',
        content: this.serializeMemoryEntries('Procedural memory', procedural),
        priority: 60,
        budgetTokens: 240,
      });
    }

    // Governed memory entries stored locally but classified by kind
    const derivedEntries = await this.memory.getDerivedMemory(5);
    if (derivedEntries.length > 0) {
      sections.push({
        id: 'memory-derived',
        source: 'derived_memory',
        content: this.serializeMemoryEntries('Derived summaries', derivedEntries),
        priority: 78,
        budgetTokens: 350,
      });
    }

    const evidenceEntries = await this.memory.getEvidenceEntries(3);
    if (evidenceEntries.length > 0) {
      sections.push({
        id: 'memory-evidence',
        source: 'evidence',
        content: this.serializeMemoryEntries('Evidence references', evidenceEntries),
        priority: 55,
        budgetTokens: 200,
      });
    }

    // Workspace-state entries stored in runtime memory (vs. adapter-provided)
    const wsEntries = await this.memory.getWorkspaceState({ limit: 5 });
    if (wsEntries.length > 0) {
      sections.push({
        id: 'memory-workspace-state',
        source: 'workspace_state',
        content: this.serializeMemoryEntries('Workspace state (local)', wsEntries),
        priority: 88,
        budgetTokens: 400,
      });
    }

    return sections;
  }

  /** Build context sections from the external workspace-state adapter. */
  private async buildWorkspaceStateSections(): Promise<ContextSectionInput[]> {
    if (!this.workspaceState) return [];
    const sections: ContextSectionInput[] = [];

    try {
      const resources = await this.workspaceState.getResources({ limit: 8 });
      if (resources.length > 0) {
        const lines = resources.map(
          (r) => `- [${r.ref.resourceType}/${r.ref.resourceId}] (as of ${r.asOf}) ${r.summary}`,
        );
        sections.push({
          id: 'workspace-state-external',
          source: 'workspace_state',
          content: `Authoritative workspace state:\n${lines.join('\n')}`,
          priority: 92,
          budgetTokens: 500,
        });
      }

      const evidence = await this.workspaceState.getEvidence({ limit: 5 });
      if (evidence.length > 0) {
        const lines = evidence.map((e) => `- ${e.summary}`);
        sections.push({
          id: 'evidence-external',
          source: 'evidence',
          content: `Evidence:\n${lines.join('\n')}`,
          priority: 58,
          budgetTokens: 250,
        });
      }
    } catch {
      // Adapter failures must not break the run; fall back to memory-only context.
    }

    return sections;
  }

  private serializeMemoryEntries(label: string, entries: MemoryEntry[]): string {
    const lines = [`${label}:`];
    for (const entry of entries) {
      lines.push(
        `- (${entry.tier}/${entry.scope}, confidence=${entry.confidence.toFixed(2)}) ${entry.content}`,
      );
    }
    return lines.join('\n');
  }

  private formatContextPlan(plan: ContextPlan): string {
    const nonEmptySections = plan.sections.filter((section) => section.content.trim().length > 0);
    if (nonEmptySections.length === 0) return '';

    const parts: string[] = [
      'Runtime context:',
      `- compiled tokens: ${plan.totalTokens}/${plan.budgetTokens}`,
      `- truncated: ${plan.hadTruncation ? 'yes' : 'no'}`,
      '',
    ];

    for (const section of nonEmptySections) {
      parts.push(`## ${section.id}`);
      parts.push(section.content);
      parts.push('');
    }

    return parts.join('\n').trim();
  }

  private async appendTranscriptEntry(
    entry: Omit<TranscriptEntry, 'id' | 'timestamp'> & Partial<Pick<TranscriptEntry, 'id' | 'timestamp'>>,
  ): Promise<TranscriptEntry> {
    const normalized: TranscriptEntry = {
      ...entry,
      id: entry.id ?? `trn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: entry.timestamp ?? Date.now(),
      metadata: entry.metadata ? { ...entry.metadata } : undefined,
    };

    await this.transcripts.append(normalized);
    return normalized;
  }

  private isBlockedResult(result: unknown): boolean {
    return !!(
      result &&
      typeof result === 'object' &&
      'blocked' in result &&
      (result as ProposalControlResult).blocked === true
    );
  }

  private buildTurnOutcome(
    turn: Turn,
    result: unknown,
  ): TurnOutcome {
    const toolExecutionSummaries = this.summarizeToolExecutionResult(turn.index, result);
    const runState = this.getNextState(turn.proposal, result);

    return {
      turnIndex: turn.index,
      output: this.buildTurnOutput(turn, result),
      matchedTools: turn.proposal.type === 'tool_call'
        ? Array.from(new Set(turn.proposal.toolCalls.map((toolCall) => toolCall.name)))
        : [],
      matchedHandoffs: turn.proposal.type === 'handoff'
        ? [turn.proposal.targetAgentId]
        : [],
      policyDecision: (result as ProposalControlResult | undefined)?.policyDecision,
      approval: this.buildApprovalStateSnapshotForTurn(turn.proposal, result),
      toolExecutionSummaries,
      usage: { ...turn.usage },
      stopReason: this.getTurnStopReason(runState, turn.proposal, result, toolExecutionSummaries),
      runState,
    };
  }

  private buildTurnOutput(turn: Turn, result: unknown): string {
    const control = result as ProposalControlResult | undefined;
    if (control?.output) {
      return control.output;
    }

    if (Array.isArray(result)) {
      const outputs = result
        .map((execution) => execution.result.uiOutput ?? execution.result.llmOutput)
        .filter((value) => typeof value === 'string' && value.trim().length > 0);

      if (outputs.length > 0) {
        return outputs.join('\n');
      }
    }

    switch (turn.proposal.type) {
      case 'final_answer':
        return turn.proposal.answer;
      case 'memory_write':
        return `Recorded ${turn.proposal.writes.length} memory write${turn.proposal.writes.length === 1 ? '' : 's'}.`;
      case 'handoff':
        return `Handoff requested to ${turn.proposal.targetAgentId}: ${turn.proposal.reason}`;
      case 'approval_request':
        return `Approval requested: ${turn.proposal.action}`;
      default:
        return turn.modelOutput;
    }
  }

  private summarizeToolExecutionResult(
    turnIndex: number,
    result: unknown,
  ): ToolExecutionSummary[] {
    if (!Array.isArray(result)) {
      return (result as ProposalControlResult | undefined)?.toolExecutionSummaries?.map((summary) => ({
        ...summary,
      })) ?? [];
    }

    return result.map((execution) => ({
      toolName: execution.toolCall.name,
      turnIndex,
      success: execution.result.success !== false,
      outcome: execution.outcome ?? this.classifyToolExecutionOutcome(execution),
      durationMs: execution.durationMs,
      error: execution.result.error,
      costUSD: execution.result.metrics?.costUSD,
    }));
  }

  private buildApprovalStateSnapshotForTurn(
    proposal: ActionProposal,
    result: unknown,
  ): ApprovalStateSnapshot {
    const control = result as ProposalControlResult | undefined;

    if (control?.approvalDecision) {
      return {
        status: control.approvalDecision.approved ? 'approved' : 'denied',
        requestId: control.approvalDecision.requestId,
        approver: control.approvalDecision.decidedBy,
        reason: control.approvalDecision.reason,
        decidedAt: control.approvalDecision.decidedAt,
      };
    }

    if (control?.waitingForApproval || proposal.type === 'approval_request') {
      return {
        status: 'requested',
        requestId: control?.requestId,
        mode: control?.approvalMode,
        reason: control?.reasons?.[0],
      };
    }

    return { status: 'none' };
  }

  private getTurnStopReason(
    runState: RunState,
    proposal: ActionProposal,
    result: unknown,
    toolExecutionSummaries: ToolExecutionSummary[],
  ): TurnStopReason {
    const control = result as ProposalControlResult | undefined;

    if (control?.waitingForApproval || proposal.type === 'approval_request' || runState === 'waiting_for_approval') {
      return 'approval_required';
    }

    if (runState === 'waiting_for_handoff' || proposal.type === 'handoff') {
      return 'handoff';
    }

    if (runState === 'suspended') {
      return 'waiting_external_event';
    }

    if (runState === 'failed') {
      if (toolExecutionSummaries.some((summary) => !summary.success)) {
        return 'tool_error';
      }
      if (control?.policyDecision || control?.approvalDecision || control?.reasons?.length) {
        return 'policy_blocked';
      }
      return proposal.type === 'tool_call' ? 'tool_error' : 'policy_blocked';
    }

    if (toolExecutionSummaries.some((summary) => !summary.success)) {
      return 'tool_error';
    }

    return 'completed';
  }

  private buildContextPlanSummary(plan: ContextPlan | null | undefined): ContextPlanSummary | undefined {
    if (!plan) return undefined;

    return {
      totalTokens: plan.totalTokens,
      budgetTokens: plan.budgetTokens,
      sectionCount: plan.sections.length,
      hadTruncation: plan.hadTruncation,
      sectionIds: plan.sections.map((section) => section.id),
    };
  }

  private buildProposalSummary(proposal: ActionProposal): string {
    switch (proposal.type) {
      case 'final_answer':
        return proposal.answer.slice(0, 160);
      case 'tool_call':
        return proposal.toolCalls.map((toolCall) => toolCall.name).join(', ');
      case 'memory_write':
        return `${proposal.writes.length} memory write(s)`;
      case 'handoff':
        return `${proposal.targetAgentId}: ${proposal.reason}`;
      case 'approval_request':
        return `${proposal.action}: ${proposal.reason}`;
      default:
        return 'proposal';
    }
  }

  private buildProposalMetadata(proposal: ActionProposal): Record<string, unknown> {
    switch (proposal.type) {
      case 'tool_call':
        return {
          toolCalls: proposal.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
          })),
        };
      case 'memory_write':
        return {
          writes: proposal.writes.length,
        };
      case 'handoff':
        return {
          targetAgentId: proposal.targetAgentId,
        };
      case 'approval_request':
        return {
          action: proposal.action,
          riskScore: proposal.riskScore,
        };
      default:
        return {};
    }
  }

  private stateRefToResourceRef(stateRef?: MemoryEntry['stateRef']): ResourceRef | undefined {
    if (!stateRef) return undefined;
    return {
      resourceType: stateRef.resourceType,
      resourceId: stateRef.resourceId,
      version: stateRef.version,
    };
  }

  private collectRoutedMatches(run: Run): RoutedCapabilityMatch[] {
    const matches: RoutedCapabilityMatch[] = [];
    const seen = new Set<string>();

    for (const turn of run.turns) {
      if (turn.proposal.type === 'tool_call') {
        for (const toolCall of turn.proposal.toolCalls) {
          const key = `tool:${toolCall.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const capability = this.executionSurface.get(toolCall.name);
          matches.push({
            kind: 'tool',
            name: toolCall.name,
            source: capability?.source,
            safetyClass: capability?.safetyClass,
          });
        }
        continue;
      }

      if (turn.proposal.type === 'handoff') {
        const key = `handoff:${turn.proposal.targetAgentId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
          kind: 'handoff',
          name: turn.proposal.targetAgentId,
        });
      }
    }

    return matches;
  }

  private buildApprovalStateSnapshotForRun(run: Run): ApprovalStateSnapshot {
    const pending = this.approvals.getPending()
      .filter((request) => request.runId === run.id)
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    if (pending) {
      return {
        status: 'requested',
        requestId: pending.id,
        mode: pending.mode,
        reason: pending.reason,
      };
    }

    const latestDecision = run.approvalDecisions.at(-1);
    if (latestDecision) {
      return {
        status: latestDecision.approved ? 'approved' : 'denied',
        requestId: latestDecision.requestId,
        approver: latestDecision.decidedBy,
        reason: latestDecision.reason,
        decidedAt: latestDecision.decidedAt,
      };
    }

    return { status: 'none' };
  }

  private async buildRunSessionSnapshot(run: Run): Promise<RunSessionSnapshot> {
    const transcriptEntries = await this.transcripts.list(run.id);
    const transcript = await this.transcripts.getRef(run.id);
    const executionGraph = await this.executionGraphs.getRef(run.id);
    const checkpoints = this.enableCheckpoints
      ? await this.checkpoints.list(run.id)
      : [];

    return {
      runId: run.id,
      agentId: run.agentId,
      prompt: run.input,
      compiledContextSummary: this.buildContextPlanSummary(this.latestContextPlans.get(run.id)),
      routedMatches: this.collectRoutedMatches(run),
      toolExecutionSummaries: run.turnOutcomes.flatMap((outcome) =>
        outcome.toolExecutionSummaries.map((summary) => ({ ...summary })),
      ),
      streamEventSummary: this.eventLog.getByRun(run.id).map((event) => ({
        type: event.type,
        timestamp: event.timestamp,
        turnIndex: event.turnIndex,
      })),
      checkpointRefs: checkpoints.map((checkpoint) => checkpoint.id),
      transcript,
      executionGraph,
      transcriptEntries: transcriptEntries.map((entry) => ({
        ...entry,
        metadata: entry.metadata ? { ...entry.metadata } : undefined,
      })),
      bootstrapReport: this.getBootstrapReport(),
      approvalState: this.buildApprovalStateSnapshotForRun(run),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private async finalizeRun(run: Run): Promise<RunResult> {
    run.updatedAt = Date.now();

    const isTerminal = run.state === 'completed' || run.state === 'failed';
    if (isTerminal) {
      this.emitEvent({
        id: eventId(),
        type: 'run_completed',
        runId: run.id,
        agentId: this.definition.id,
        timestamp: Date.now(),
        data: {
          output: run.output ?? '',
          state: run.state,
          turnCount: run.turns.length,
          totalUsage: run.totalUsage,
        },
      });
    }

    if (run.state === 'failed') {
      const failedTurnIndex = run.turns.length > 0
        ? run.turns[run.turns.length - 1].index
        : 0;
      this.emitEvent({
        id: eventId(),
        type: 'run_failed',
        runId: run.id,
        agentId: this.definition.id,
        turnIndex: failedTurnIndex,
        timestamp: Date.now(),
        data: {
          error: run.error ?? 'Run failed',
          turnIndex: failedTurnIndex,
        },
      });
    }

    await this.appendExecutionNode(run.id, {
      turnIndex: run.turns.at(-1)?.index,
      kind: 'completion',
      phase: 'completion',
      actor: this.buildActorRef('system', this.definition.id, this.definition.name),
      status: run.state === 'failed' ? 'failure' : 'success',
      summary: `Run ${run.state}`,
      metadata: {
        output: run.output,
        error: run.error,
      },
    });

    return await this.buildRunResult(run);
  }

  /** Build the final run result. */
  private async buildRunResult(run: Run): Promise<RunResult> {
    await this.emitAuditBundle(run).catch(() => {});

    const session = await this.buildRunSessionSnapshot(run);
    this.latestSessionSnapshots.set(run.id, session);
    await this.persistRunState(run, session);
    await this.persistThreadState(run, session);
    const executionGraph = await this.executionGraphs.getGraph(run.id);

    // Build response envelope when identity claims are configured
    let responseEnvelope: ResponseEnvelope | null = null;
    if (this.identityClaims && run.output) {
      responseEnvelope = await this.buildResponseEnvelope({
        runId: run.id,
        output: run.output,
        model: this.definition.model.model,
        provider: this.definition.model.provider,
        policySnapshot: run.turnOutcomes
          .filter((o) => o.policyDecision)
          .map((o) => ({
            ruleId: o.policyDecision!.checks[0]?.ruleId ?? 'unknown',
            verdict: o.policyDecision!.verdict,
            riskScore: o.policyDecision!.riskScore,
            evaluatedAt: o.policyDecision!.evaluatedAt,
          })),
      });
    }

    return {
      run,
      output: run.output ?? run.error ?? '',
      events: this.eventLog.getByRun(run.id),
      usage: run.totalUsage,
      turnOutcomes: run.turnOutcomes.map((outcome) => ({
        ...outcome,
        matchedTools: [...outcome.matchedTools],
        matchedHandoffs: [...outcome.matchedHandoffs],
        toolExecutionSummaries: outcome.toolExecutionSummaries.map((summary) => ({ ...summary })),
      })),
      session,
      executionGraph,
      bootstrapReport: this.getBootstrapReport(),
      responseEnvelope,
    };
  }

  /** Emit an audit bundle for a completed run. */
  private async emitAuditBundle(run: Run): Promise<void> {
    const toolExecutions = run.turns
      .filter((t) => t.proposal.type === 'tool_call')
      .flatMap((t) => {
        const results = t.result as Array<{
          toolCall: ToolCall;
          result: { llmOutput: string; success?: boolean; error?: string };
          durationMs: number;
        }> | undefined;
        if (!Array.isArray(results)) {
          return [];
        }
        return results.map((r) => ({
          toolName: r.toolCall.name,
          turnIndex: t.index,
          success: r.result.success !== false,
          durationMs: r.durationMs,
          error: r.result.error,
        }));
      });

    const bundle = await this.audit.emit({
      runId: run.id,
      agentId: this.definition.id,
      runStartedAt: run.createdAt,
      runEndedAt: run.updatedAt,
      finalState: run.state,
      totalUsage: run.totalUsage,
      totalSpendUSD: this.payments?.getRunSpend() ?? 0,
      turnCount: run.turns.length,
      events: this.eventLog.getByRun(run.id),
      policyDecisions: run.policyDecisions,
      approvalDecisions: run.approvalDecisions,
      toolExecutions: toolExecutions.length > 0
        ? toolExecutions
        : run.turnOutcomes.flatMap((outcome) =>
            outcome.toolExecutionSummaries.map((summary) => ({ ...summary })),
          ),
    });
    await this.appendExecutionNode(run.id, {
      turnIndex: run.turns.at(-1)?.index,
      kind: 'evidence_bundle',
      phase: 'evidence',
      actor: this.buildActorRef('system', 'audit-emitter', 'Audit Emitter'),
      status: 'success',
      summary: `Evidence bundle recorded (${bundle.id})`,
      metadata: {
        bundleId: bundle.id,
        contentHash: bundle.contentHash,
      },
    }, 'recorded_as');
    this.emitEvent({
      id: eventId(),
      type: 'evidence_bundle_recorded',
      runId: run.id,
      agentId: this.definition.id,
      turnIndex: run.turns.at(-1)?.index,
      timestamp: Date.now(),
      data: {
        bundleId: bundle.id,
        contentHash: bundle.contentHash,
      },
    });
  }

  /**
   * Dispose installed plugins. Idempotent; safe to call multiple times.
   * Plugin `dispose()` errors are caught and logged so one failing plugin
   * does not prevent others from cleaning up.
   */
  dispose(): void {
    while (this.plugins.length > 0) {
      const plugin = this.plugins.pop();
      try {
        plugin?.dispose?.();
      } catch (err) {
        console.warn(
          `[AgentRuntime] plugin "${plugin?.id ?? '<unknown>'}" dispose() threw:`,
          err,
        );
      }
    }
  }
}
