/**
 * @packageDocumentation
 * @module AgentTypes
 * @description
 * Core agent definition types for the Veridex Agent Fabric.
 *
 * An AgentDefinition is the declarative specification of an agent —
 * its identity, model, tools, memory, payments, policies, and hooks.
 */

import type { ToolContract } from './tools';
import type { ToolAttachment } from './tools';
import type { MemoryConfig } from './memory';
import type { RuntimeHook } from './hooks';
import type { ModelConfig } from './models';
import type { ExecutableCapability } from './execution';
import type { TranscriptStore } from './transcript';
import type { WorkspaceStateProvider } from '../integrations/WorkspaceStateAdapter';
import type { ContextRetrievalPolicy } from './context';
import type { TransportAvailability } from './bootstrap';
import type {
  ExecutionGraphStore,
  MemoryProposalValidator,
  RunStore,
  ThreadStore,
} from './accountability';
import type { AgentIdentityClaims } from './identity';

// ── Agent Definition ──

/** The declarative specification of an agent. */
export interface AgentDefinition {
  /** Unique agent identifier */
  id: string;
  /** Human-readable agent name */
  name: string;
  /** Model configuration (provider, model, fallback, temperature) */
  model: ModelConfig;
  /** System instructions for the agent */
  instructions: string;
  /** Tool contracts available to this agent */
  tools?: ToolContract[];
  /** Memory configuration */
  memory?: MemoryConfig;
  /** Payment configuration (requires @veridex/agentic-payments) */
  payments?: PaymentConfig;
  /** Policy configurations */
  policies?: PolicyConfig[];
  /** Lifecycle hooks keyed by phase */
  hooks?: Record<string, RuntimeHook[]>;
  /** Maximum turns per run before forced completion */
  maxTurns?: number;
  /** Maximum total tokens per run */
  maxTokens?: number;
  /** Agent metadata */
  metadata?: Record<string, unknown>;
}

// ── Payment Config ──

/** Payment configuration for agents with payment capabilities. */
export interface PaymentConfig {
  /** Daily spending limit in USD */
  dailyLimitUSD?: number;
  /** Per-transaction spending limit in USD */
  perTransactionLimitUSD?: number;
  /** Allowed chains for payment (chain names) */
  allowedChains?: string[];
  /** Allowed protocols for payment */
  allowedProtocols?: string[];
  /** Whether to require approval for financial tool calls */
  requireApproval?: boolean;
}

// ── Policy Config ──

/** Policy configuration entry. */
export interface PolicyConfig {
  /** Policy type identifier */
  type: string;
  /** Policy parameters */
  params: Record<string, unknown>;
}

// ── Handoff Runtime ──

/** Context passed to a live handoff handler when another agent/runtime is invoked. */
export interface HandoffExecutionContext {
  /** Current run identifier */
  runId: string;
  /** Local agent identifier */
  agentId: string;
  /** Current turn index */
  turnIndex: number;
  /** Target handoff identifier */
  targetAgentId: string;
  /** Human/model-provided handoff reason */
  reason: string;
  /** Optional context string to forward */
  context?: string;
  /** Veridex SDK if available */
  sdk?: unknown;
  /** Agent wallet if available */
  wallet?: unknown;
}

/** Result returned by a live handoff handler. */
export interface HandoffExecutionResult {
  /** Whether the handoff completed successfully */
  success: boolean;
  /** Output to feed back as the run's final output */
  output: string;
  /** Optional UI-facing output */
  uiOutput?: string;
  /** Optional structured metadata */
  metadata?: Record<string, unknown>;
  /** Optional attachments returned by the remote runtime */
  attachments?: ToolAttachment[];
  /** Optional error message for failed handoffs */
  error?: string;
}

/** Handler for executing a live agent handoff to another runtime or remote agent. */
export type HandoffHandler = (
  context: HandoffExecutionContext,
) => Promise<HandoffExecutionResult>;

// ── Runtime Options ──

/** Options for configuring the agent runtime. */
export interface RuntimeOptions {
  /** Veridex SDK instance (optional — enables identity/session features) */
  veridexSDK?: unknown;
  /** Veridex AgentWallet instance (optional — enables payment features) */
  agentWallet?: unknown;
  /** Custom model providers to register */
  modelProviders?: Record<string, unknown>;
  /** Whether to enable trace event logging (default: true) */
  enableTracing?: boolean;
  /** Whether to enable checkpointing (default: false) */
  enableCheckpoints?: boolean;
  /** Checkpoint store implementation */
  checkpointStore?: unknown;
  /** Memory store implementation */
  memoryStore?: unknown;
  /** Transcript store implementation for replay/debugging */
  transcriptStore?: TranscriptStore;
  /** Durable run store implementation */
  runStore?: RunStore;
  /** Durable thread store implementation */
  threadStore?: ThreadStore;
  /** Durable execution-graph store implementation */
  executionGraphStore?: ExecutionGraphStore;
  /** External event handler */
  onEvent?: (event: unknown) => void;
  /** Policy rules to register on the engine */
  policyRules?: unknown[];
  /** Approval routes to register */
  approvalRoutes?: unknown[];
  /** Approval handlers keyed by approval mode */
  approvalHandlers?: Record<string, (request: unknown) => Promise<unknown>>;
  /** Audit sinks to register */
  auditSinks?: unknown[];
  /** Additional execution capabilities imported from adapters or remote transports */
  executionCapabilities?: ExecutableCapability[];
  /** Availability flags for transport surfaces shown in bootstrap reports */
  transportAvailability?: Partial<TransportAvailability>;
  /** Control-plane connectivity status for bootstrap reporting */
  controlPlaneConnected?: boolean | null;
  /** Live handoff handlers keyed by target agent/runtime identifier */
  handoffHandlers?: Record<string, HandoffHandler>;
  /** Workspace state provider for governed state reads and mutation proposals */
  workspaceStateProvider?: WorkspaceStateProvider;
  /** Context retrieval policy controlling source ordering and per-source defaults */
  retrievalPolicy?: ContextRetrievalPolicy;
  /**
   * Opt-in fidelity-aware context engine. When provided (or set to an
   * options object), the runtime wraps the {@link ContextCompiler} with
   * a {@link HomeostaticContextEngine} and emits `context_fidelity`
   * events on every compile.
   */
  homeostatic?:
    | import('../context/HomeostaticContextEngine').HomeostaticContextEngine
    | import('../context/HomeostaticContextEngine').HomeostaticContextEngineOptions;
  /**
   * Compactor invoked when the homeostatic engine fires a compaction
   * trigger. Required for actual rewriting; without it, triggers are
   * surfaced as events only.
   */
  compactor?: import('../context/Compactor').Compactor;
  /**
   * When `true`, the runtime renders only one-line summaries in the
   * tool catalog section of the system prompt and auto-registers a
   * built-in `load_tool(name)` action so the model can fetch full
   * schemas on demand. Reduces baseline prompt tokens by 60–90% for
   * agents with large tool surfaces. Defaults to `false`.
   */
  progressiveToolDisclosure?: boolean;
  /** Validators for governed memory/resource proposals before commit */
  memoryProposalValidators?: MemoryProposalValidator[];
  /** Agent identity claims (OIDC-A). When provided, identity + integrity are computed at boot. */
  identityClaims?: AgentIdentityClaims;
  /** Whether to compute and cache agent integrity binding at boot (default: true when identityClaims present) */
  enableIntegrity?: boolean;
  /** Intent verifier pipeline for pre-policy action verification. */
  intentVerifier?: import('../intent/IntentVerification').IntentVerifier;
  /**
   * Agent registry bridge config. When provided, the agent auto-registers
   * in the relayer so it appears in the developer portal, and can load
   * portal-created agents.
   */
  registryBridge?: import('../registry/AgentRegistryBridge').AgentRegistryConfig;
  /**
   * Standalone security gateway instance from @veridex/agent-security.
   * When provided, each proposal is evaluated through both the internal
   * PolicyEngine AND the standalone gateway, with worst-verdict-wins.
   * This is the same gateway external (non-SDK) agents use, ensuring
   * parity of security enforcement.
   */
  securityGateway?: {
    evaluate(ctx: {
      agent: { agentId: string; name?: string; framework?: string };
      action: { type: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; description?: string }>; content?: string; amountUsd?: number; chain?: string; targetAddress?: string; targetAgentId?: string };
      runId?: string;
      turnIndex?: number;
      runSpendUsd?: number;
      totalTokens?: number;
    }): Promise<{ verdict: string; riskScore: number; reasons: string[]; checks: unknown[]; packsEvaluated: string[]; evaluatedAt: number; durationMs: number }>;
  };
}
