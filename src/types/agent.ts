/**
 * @packageDocumentation
 * @module AgentTypes
 * @description
 * Core agent definition types for the Veridex Agent Fabric.
 *
 * An AgentDefinition is the declarative specification of an agent —
 * its identity, model, tools, memory, payments, policies, and hooks.
 */

import type { z } from 'zod';
import type { ToolContract } from './tools';
import type { ToolAttachment } from './tools';
import type { MemoryConfig } from './memory';
import type { RuntimeHook } from './hooks';
import type { ModelConfig } from './models';

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
  /** External event handler */
  onEvent?: (event: unknown) => void;
  /** Policy rules to register on the engine */
  policyRules?: unknown[];
  /** Approval routes to register */
  approvalRoutes?: unknown[];
  /** Audit sinks to register */
  auditSinks?: unknown[];
  /** Live handoff handlers keyed by target agent/runtime identifier */
  handoffHandlers?: Record<string, HandoffHandler>;
}
