/**
 * @packageDocumentation
 * @module EventTypes
 * @description
 * Structured trace event types for event sourcing in the Veridex Agent Fabric.
 *
 * Every significant action emits a structured event — the foundation
 * for the control plane, replay, and audit.
 */

import type { ModelUsage } from './models';
import type { RunState } from './runtime';

// ── Event Types ──

/** All trace event type identifiers. */
export type TraceEventType =
  | 'message_received'
  | 'context_compiled'
  | 'model_call_started'
  | 'model_call_completed'
  | 'tool_proposed'
  | 'tool_executed'
  | 'memory_written'
  | 'payment_attempted'
  | 'approval_requested'
  | 'handoff_initiated'
  | 'run_checkpointed'
  | 'policy_evaluated'
  | 'hook_executed'
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'error_occurred';

// ── Base Event ──

/** Base fields for all trace events. */
export interface BaseTraceEvent {
  /** Unique event identifier */
  id: string;
  /** Event type discriminator */
  type: TraceEventType;
  /** Run ID this event belongs to */
  runId: string;
  /** Agent ID */
  agentId: string;
  /** Turn index (if applicable) */
  turnIndex?: number;
  /** Event timestamp */
  timestamp: number;
  /** Additional event metadata */
  metadata?: Record<string, unknown>;
}

// ── Specific Events ──

export interface MessageReceivedEvent extends BaseTraceEvent {
  type: 'message_received';
  data: { content: string; source: 'user' | 'system' | 'agent' };
}

export interface ContextCompiledEvent extends BaseTraceEvent {
  type: 'context_compiled';
  data: { totalTokens: number; sectionCount: number; hadTruncation: boolean };
}

export interface ModelCallStartedEvent extends BaseTraceEvent {
  type: 'model_call_started';
  data: { provider: string; model: string };
}

export interface ModelCallCompletedEvent extends BaseTraceEvent {
  type: 'model_call_completed';
  data: {
    usage: ModelUsage;
    finishReason: string;
  };
}

export interface ToolProposedEvent extends BaseTraceEvent {
  type: 'tool_proposed';
  data: { toolName: string; arguments: Record<string, unknown>; safetyClass: string };
}

export interface ToolExecutedEvent extends BaseTraceEvent {
  type: 'tool_executed';
  data: {
    toolName: string;
    success: boolean;
    durationMs: number;
    error?: string;
  };
}

export interface MemoryWrittenEvent extends BaseTraceEvent {
  type: 'memory_written';
  data: { tier: string; entryId: string; scope: string; provenance: string };
}

export interface PaymentAttemptedEvent extends BaseTraceEvent {
  type: 'payment_attempted';
  data: {
    protocol: string;
    amountUSD: number;
    chain: string;
    recipient: string;
    success: boolean;
    txHash?: string;
    error?: string;
  };
}

export interface ApprovalRequestedEvent extends BaseTraceEvent {
  type: 'approval_requested';
  data: { action: string; reason: string; riskScore: number };
}

export interface HandoffInitiatedEvent extends BaseTraceEvent {
  type: 'handoff_initiated';
  data: { targetAgentId: string; reason: string };
}

export interface RunCheckpointedEvent extends BaseTraceEvent {
  type: 'run_checkpointed';
  data: { checkpointId: string; turnIndex: number; state: string };
}

export interface PolicyEvaluatedEvent extends BaseTraceEvent {
  type: 'policy_evaluated';
  data: { verdict: string; riskScore: number; reasons: string[] };
}

export interface HookExecutedEvent extends BaseTraceEvent {
  type: 'hook_executed';
  data: { hookName: string; phase: string; durationMs: number; override?: string };
}

export interface RunStartedEvent extends BaseTraceEvent {
  type: 'run_started';
  data: { input: string };
}

export interface RunCompletedEvent extends BaseTraceEvent {
  type: 'run_completed';
  data: { output: string; state: RunState; turnCount: number; totalUsage: ModelUsage };
}

export interface RunFailedEvent extends BaseTraceEvent {
  type: 'run_failed';
  data: { error: string; turnIndex: number };
}

export interface ErrorOccurredEvent extends BaseTraceEvent {
  type: 'error_occurred';
  data: { error: string; phase: string; recoverable: boolean };
}

// ── Discriminated Union ──

/** Discriminated union of all trace event types. */
export type TraceEvent =
  | MessageReceivedEvent
  | ContextCompiledEvent
  | ModelCallStartedEvent
  | ModelCallCompletedEvent
  | ToolProposedEvent
  | ToolExecutedEvent
  | MemoryWrittenEvent
  | PaymentAttemptedEvent
  | ApprovalRequestedEvent
  | HandoffInitiatedEvent
  | RunCheckpointedEvent
  | PolicyEvaluatedEvent
  | HookExecutedEvent
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | ErrorOccurredEvent;
