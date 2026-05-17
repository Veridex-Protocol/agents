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
import type { RuntimeBootstrapReport } from './bootstrap';

// ── Event Types ──

/** All trace event type identifiers. */
export type TraceEventType =
  | 'bootstrap_report_generated'
  | 'message_received'
  | 'context_compiled'
  | 'context_fidelity'
  | 'context_compacted'
  | 'model_call_started'
  | 'model_call_completed'
  | 'token_streamed'
  | 'proposal_created'
  | 'proposal_validated'
  | 'tool_proposed'
  | 'capability_invoked'
  | 'tool_executed'
  | 'memory_written'
  | 'payment_attempted'
  | 'approval_requested'
  | 'approval_resolved'
  | 'handoff_initiated'
  | 'resource_mutation_proposed'
  | 'resource_mutation_committed'
  | 'side_effect_receipt_recorded'
  | 'evidence_bundle_recorded'
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

export interface BootstrapReportGeneratedEvent extends BaseTraceEvent {
  type: 'bootstrap_report_generated';
  data: { report: RuntimeBootstrapReport };
}

export interface ContextCompiledEvent extends BaseTraceEvent {
  type: 'context_compiled';
  data: { totalTokens: number; sectionCount: number; hadTruncation: boolean };
}

export interface ContextFidelityEvent extends BaseTraceEvent {
  type: 'context_fidelity';
  data: {
    modelId: string;
    promptTokens: number;
    fidelity: number;
    fidelityTarget: number;
    pGate: number;
    pGateUsage: number;
    compactionTriggered: boolean;
    reasons: string[];
  };
}

export interface ContextCompactedEvent extends BaseTraceEvent {
  type: 'context_compacted';
  data: {
    compactorId: string;
    tokensShed: number;
    actions: Array<{ sectionId: string; kind: string; reason?: string; tokensBefore: number; tokensAfter: number }>;
    notes?: string;
  };
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

export interface ProposalCreatedEvent extends BaseTraceEvent {
  type: 'proposal_created';
  data: { proposalType: string; summary: string };
}

export interface ProposalValidatedEvent extends BaseTraceEvent {
  type: 'proposal_validated';
  data: { proposalType: string; accepted: boolean; issues?: string[] };
}

export interface ToolProposedEvent extends BaseTraceEvent {
  type: 'tool_proposed';
  data: { toolName: string; arguments: Record<string, unknown>; safetyClass: string };
}

export interface CapabilityInvokedEvent extends BaseTraceEvent {
  type: 'capability_invoked';
  data: {
    capabilityName: string;
    source?: string;
    safetyClass?: string;
    idempotencyKey?: string;
  };
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

export interface ApprovalResolvedEvent extends BaseTraceEvent {
  type: 'approval_resolved';
  data: { requestId?: string; approved: boolean; approver?: string; reason?: string };
}

export interface HandoffInitiatedEvent extends BaseTraceEvent {
  type: 'handoff_initiated';
  data: { targetAgentId: string; reason: string };
}

export interface ResourceMutationProposedEvent extends BaseTraceEvent {
  type: 'resource_mutation_proposed';
  data: { resourceType: string; resourceId: string; operation: string; accepted?: boolean };
}

export interface ResourceMutationCommittedEvent extends BaseTraceEvent {
  type: 'resource_mutation_committed';
  data: { resourceType: string; resourceId: string; accepted: boolean; reason?: string };
}

export interface SideEffectReceiptRecordedEvent extends BaseTraceEvent {
  type: 'side_effect_receipt_recorded';
  data: { capabilityName: string; receiptId: string; idempotencyKey: string; status: string };
}

export interface EvidenceBundleRecordedEvent extends BaseTraceEvent {
  type: 'evidence_bundle_recorded';
  data: { bundleId: string; contentHash: string };
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

export interface TokenStreamedEvent extends BaseTraceEvent {
  type: 'token_streamed';
  data: { token: string; tokenIndex: number };
}

// ── Discriminated Union ──

/** Discriminated union of all trace event types. */
export type TraceEvent =
  | BootstrapReportGeneratedEvent
  | MessageReceivedEvent
  | ContextCompiledEvent
  | ContextFidelityEvent
  | ContextCompactedEvent
  | ModelCallStartedEvent
  | ModelCallCompletedEvent
  | TokenStreamedEvent
  | ProposalCreatedEvent
  | ProposalValidatedEvent
  | ToolProposedEvent
  | CapabilityInvokedEvent
  | ToolExecutedEvent
  | MemoryWrittenEvent
  | PaymentAttemptedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | HandoffInitiatedEvent
  | ResourceMutationProposedEvent
  | ResourceMutationCommittedEvent
  | SideEffectReceiptRecordedEvent
  | EvidenceBundleRecordedEvent
  | RunCheckpointedEvent
  | PolicyEvaluatedEvent
  | HookExecutedEvent
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | ErrorOccurredEvent;
