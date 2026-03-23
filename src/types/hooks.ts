/**
 * @packageDocumentation
 * @module HookTypes
 * @description
 * Hook system types for the Veridex Agent Fabric.
 *
 * Hooks exist at 21 lifecycle phases, supporting priority ordering,
 * timeout, fault isolation, and short-circuit overrides.
 */

// ── Hook Phases ──

/** All 21 runtime lifecycle hook phases per proposal §9.1. */
export type HookPhase =
  | 'beforeRun'
  | 'afterRun'
  | 'beforeTurn'
  | 'afterTurn'
  | 'beforeContextCompile'
  | 'afterContextCompile'
  | 'beforeModelCall'
  | 'afterModelCall'
  | 'beforeToolValidation'
  | 'afterToolValidation'
  | 'beforeToolExecute'
  | 'afterToolExecute'
  | 'beforeMemoryWrite'
  | 'afterMemoryWrite'
  | 'beforePayment'
  | 'afterPayment'
  | 'beforeApprovalRequest'
  | 'afterApprovalDecision'
  | 'beforeHandoff'
  | 'afterHandoff'
  | 'onPolicyViolation'
  | 'onError'
  | 'onTraceEvent';

// ── Hook Result ──

/** Result returned by a hook execution. */
export interface HookResult {
  /** Annotations to attach to the current context */
  annotations?: Record<string, unknown>;
  /** Override directive for the runtime */
  override?: HookOverride;
  /** Human-readable reason for the override */
  reason?: string;
}

/** Override directives a hook can issue. */
export type HookOverride = 'continue' | 'pause' | 'deny' | 'retry';

// ── Runtime Hook ──

/** A runtime lifecycle hook. */
export interface RuntimeHook<TContext = unknown> {
  /** Unique hook name */
  name: string;
  /** Which lifecycle phase this hook runs at */
  phase: HookPhase;
  /** Priority (lower = runs first, default: 100) */
  priority?: number;
  /** Timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
  /** Capabilities this hook requires */
  capabilities?: string[];
  /** The hook execution function */
  execute: (ctx: TContext) => Promise<HookResult | void> | HookResult | void;
}

// ── Hook Manifest ──

/** Manifest for a hook package (plugin governance). */
export interface HookManifest {
  /** Hook/plugin name */
  name: string;
  /** Semantic version */
  version: string;
  /** Runtime target */
  runtime: 'node' | 'worker' | 'container' | 'remote';
  /** Required permissions */
  permissions: HookPermission[];
  /** Required secrets (env var names) */
  secrets?: string[];
  /** Whether the package is cryptographically signed */
  signed?: boolean;
  /** Sandbox profile */
  sandboxProfile?: 'strict' | 'standard' | 'privileged';
}

/** Permission types for hook packages. */
export type HookPermission =
  | 'network'
  | 'fs'
  | 'payments'
  | 'memory'
  | 'identity';

// ── Hook Context Types ──

/** Context passed to beforeRun / afterRun hooks. */
export interface RunHookContext {
  runId: string;
  agentId: string;
  input: string;
  state: string;
  metadata?: Record<string, unknown>;
}

/** Context passed to beforeTurn / afterTurn hooks. */
export interface TurnHookContext {
  runId: string;
  agentId: string;
  turnIndex: number;
  input: string;
  output?: string;
  metadata?: Record<string, unknown>;
}

/** Context passed to tool-related hooks. */
export interface ToolHookContext {
  runId: string;
  agentId: string;
  turnIndex: number;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: unknown;
  safetyClass: string;
  metadata?: Record<string, unknown>;
}

/** Context passed to error hooks. */
export interface ErrorHookContext {
  runId: string;
  agentId: string;
  turnIndex?: number;
  error: Error;
  phase: string;
  metadata?: Record<string, unknown>;
}
