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

/** A typed contract defining a tool's interface, behavior, and constraints. */
export interface ToolContract<
  TInput = unknown,
  TOutput = unknown,
> {
  /** Unique tool name */
  name: string;
  /** Human-readable description (shown to model) */
  description: string;
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
