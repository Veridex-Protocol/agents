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
}
