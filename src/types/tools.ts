/**
 * @packageDocumentation
 * @module ToolTypes
 * @description
 * Tool contract and result types for the Veridex Agent Fabric.
 *
 * Every tool defines a typed contract with safety class, schema,
 * timeout, retry, and permissions. Tool results support the Pi-style
 * split between LLM output and UI output.
 */

import type { z } from 'zod';

// ── Tool Safety Classes ──

/** Safety classification for tools — feeds approval and policy engines. */
export type ToolSafetyClass =
  | 'read'
  | 'write'
  | 'network'
  | 'financial'
  | 'destructive'
  | 'privileged';

// ── Tool Contract ──

/**
 * Structured guidance composed into the description shown to the model.
 *
 * Anthropic's "Writing tools for agents" guidance argues that tool
 * descriptions should answer four questions explicitly:
 *
 *   1. What does this tool do? (one sentence verb phrase)
 *   2. When SHOULD the model use it? (concrete situations)
 *   3. When should the model NOT use it? (anti-patterns, alternatives)
 *   4. What does a successful result look like?
 *
 * These fields encode that contract. `compileToolDescription()` flattens
 * them into the single `description` string the model actually sees.
 */
export interface ToolDescriptionGuidance {
  /** One-sentence verb phrase. "Fetch the on-chain balance for a wallet." */
  summary?: string;
  /** Concrete situations where the model should reach for this tool. */
  whenToUse?: string[];
  /** Anti-patterns or cases where a different tool is better. */
  whenNotToUse?: string[];
  /** Description of what a successful result looks like. */
  successExample?: string;
}

/**
 * Templates that shape error messages into something the model can act on.
 *
 * Anthropic's research found a ~40% reduction in retry loops just from
 * rewriting error messages to be model-actionable. A bad message says
 * `Error: 400 Bad Request`. A good one says
 * `Token limit 500 exceeded — summarise the input or pass a smaller chunk.`
 *
 * Template strings may reference `{message}` (the underlying error message)
 * and any keys present in the `details` object passed to `formatToolError`.
 */
export interface ToolErrorTemplates {
  /** Default template used when no specific code matches. */
  default?: string;
  /** Per-error-code templates. Keys are stable error codes, e.g. `timeout`, `rate_limited`, `validation`, `not_found`. */
  byCode?: Record<string, string>;
}

/** A typed contract defining a tool's interface, behavior, and constraints. */
export interface ToolContract<
  TInput = unknown,
  TOutput = unknown,
> {
  /** Unique tool name */
  name: string;
  /**
   * Human-readable description (shown to model). Built automatically by
   * the `tool()` helper from `guidance` if not supplied directly.
   */
  description: string;
  /** Structured description guidance (preserved for introspection / lint). */
  guidance?: ToolDescriptionGuidance;
  /** Input schema (Zod or JSON Schema) */
  input: z.ZodType<TInput> | Record<string, unknown>;
  /** Output schema (Zod or JSON Schema, optional) */
  output?: z.ZodType<TOutput> | Record<string, unknown>;
  /** Safety classification */
  safetyClass: ToolSafetyClass;
  /** The tool execution function */
  execute: (params: ToolExecuteParams<TInput>) => Promise<ToolResult>;
  /** Execution timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Number of retry attempts on failure (default: 0) */
  retries?: number;
  /** Whether the tool is idempotent (safe to retry) */
  idempotent?: boolean;
  /** Required permissions */
  permissions?: string[];
  /** Cost estimate behavior */
  costEstimate?: (input: TInput) => CostEstimate;
  /** Templates for shaping error messages into model-actionable feedback. */
  errorTemplates?: ToolErrorTemplates;
  /** Source metadata preserved across imports/bridges. */
  metadata?: Record<string, unknown>;
}

// ── Tool Execute Params ──

/** Parameters passed to a tool's execute function. */
export interface ToolExecuteParams<TInput = unknown> {
  /** Validated input data */
  input: TInput;
  /** Runtime context (SDK, wallet, etc.) */
  context: ToolContext;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/** Runtime context available to tools during execution. */
export interface ToolContext {
  /** Run ID */
  runId: string;
  /** Agent ID */
  agentId: string;
  /** Turn index */
  turnIndex: number;
  /** Veridex SDK (if available) */
  sdk?: unknown;
  /** Agent wallet (if available) */
  wallet?: unknown;
  /** Additional context data */
  [key: string]: unknown;
}

// ── Tool Result (Pi-style split) ──

/** Tool result with split outputs per Pi ecosystem pattern. */
export interface ToolResult {
  /** Output for the LLM to reason about */
  llmOutput: string;
  /** Output for the UI/user (optional, can differ from llmOutput) */
  uiOutput?: string;
  /** File or data attachments */
  attachments?: ToolAttachment[];
  /** Execution metrics */
  metrics?: ToolMetrics;
  /** Hints for the model about what to do next */
  followUpHints?: string[];
  /** Whether the tool execution succeeded */
  success: boolean;
  /** Error message if the tool failed */
  error?: string;
}

/** A file or data attachment from a tool result. */
export interface ToolAttachment {
  /** Attachment name */
  name: string;
  /** MIME type */
  mimeType: string;
  /** Content (string or base64-encoded binary) */
  content: string;
}

/** Metrics from tool execution. */
export interface ToolMetrics {
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Estimated cost in USD (if applicable) */
  costUSD?: number;
  /** Tokens used (if applicable) */
  tokensUsed?: number;
  /** Custom metrics */
  [key: string]: unknown;
}

// ── Cost Estimate ──

/** Pre-execution cost estimate for a tool call. */
export interface CostEstimate {
  /** Estimated cost in USD */
  estimatedUSD: number;
  /** Cost confidence (0-1) */
  confidence: number;
  /** Cost breakdown */
  breakdown?: Record<string, number>;
}

// ── Tool Call (from model output) ──

/** A tool call as parsed from model output. */
export interface ToolCall {
  /** Tool name */
  name: string;
  /** Tool arguments (parsed JSON) */
  arguments: Record<string, unknown>;
  /** Tool call ID (for correlating results) */
  id: string;
}
