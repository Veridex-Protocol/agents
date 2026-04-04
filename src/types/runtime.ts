/**
 * @packageDocumentation
 * @module RuntimeTypes
 * @description
 * Run and turn state machine types for the Veridex Agent Fabric.
 *
 * Runs have durable states that make enterprise operations tractable.
 * Each turn represents one model call + action cycle.
 */

import type { ActionProposal } from './proposals';
import type { TraceEvent } from './events';
import type { ModelUsage } from './models';
import type { PolicyDecision } from './policy';
import type { CapabilitySource } from './execution';
import type { TranscriptEntry, TranscriptRef } from './transcript';
import type { RuntimeBootstrapReport } from './bootstrap';
import type { ExecutionGraph, ExecutionGraphRef } from './accountability';
import type { ApprovalDecision, ApprovalMode } from '../approvals/ApprovalManager';
import type { ToolExecutionSummary } from '../audit/AuditEmitter';

// ── Run States ──

/** Durable run states per proposal §8.3. */
export type RunState =
  | 'queued'
  | 'running'
  | 'waiting_for_tool'
  | 'waiting_for_approval'
  | 'waiting_for_handoff'
  | 'suspended'
  | 'failed'
  | 'completed';

export type TurnStopReason =
  | 'completed'
  | 'max_turns_reached'
  | 'max_budget_reached'
  | 'approval_required'
  | 'policy_blocked'
  | 'tool_error'
  | 'handoff'
  | 'waiting_external_event';

export interface ApprovalStateSnapshot {
  /** Current approval state for a turn/run. */
  status: 'none' | 'requested' | 'approved' | 'denied';
  /** Approval request identifier when one exists. */
  requestId?: string;
  /** Approval mode used by the workflow. */
  mode?: ApprovalMode;
  /** Approver identity for resolved decisions. */
  approver?: string;
  /** Human-readable reason. */
  reason?: string;
  /** Decision timestamp when available. */
  decidedAt?: number;
}

export interface ContextPlanSummary {
  /** Total tokens in the compiled context. */
  totalTokens: number;
  /** Token budget applied during compilation. */
  budgetTokens: number;
  /** Number of included sections. */
  sectionCount: number;
  /** Whether truncation happened. */
  hadTruncation: boolean;
  /** Included context section identifiers. */
  sectionIds: string[];
}

export interface RoutedCapabilityMatch {
  /** Match kind visible to operators and UIs. */
  kind: 'tool' | 'handoff';
  /** Matched capability name. */
  name: string;
  /** Capability source when known. */
  source?: CapabilitySource;
  /** Safety class when known. */
  safetyClass?: string;
}

export interface TurnOutcome {
  /** Turn index (0-based). */
  turnIndex: number;
  /** Final output or control output for this turn. */
  output: string;
  /** Tools matched/executed during the turn. */
  matchedTools: string[];
  /** Handoffs matched/executed during the turn. */
  matchedHandoffs: string[];
  /** Policy decision applied to this turn when present. */
  policyDecision?: PolicyDecision;
  /** Approval state snapshot for this turn. */
  approval: ApprovalStateSnapshot;
  /** Tool execution summaries for this turn. */
  toolExecutionSummaries: ToolExecutionSummary[];
  /** Usage recorded for this turn. */
  usage: ModelUsage;
  /** Stop reason for this turn. */
  stopReason: TurnStopReason;
  /** Run state after this turn completed. */
  runState: RunState;
}

export interface RunSessionSnapshot {
  /** Run identifier. */
  runId: string;
  /** Agent identifier. */
  agentId: string;
  /** Prompt that started the run. */
  prompt: string;
  /** Summary of the most recently compiled context. */
  compiledContextSummary?: ContextPlanSummary;
  /** Routed capability matches observed during execution. */
  routedMatches: RoutedCapabilityMatch[];
  /** Flattened tool execution summary across the run. */
  toolExecutionSummaries: ToolExecutionSummary[];
  /** Minimal event stream summary. */
  streamEventSummary: Array<{
    type: TraceEvent['type'];
    timestamp: number;
    turnIndex?: number;
  }>;
  /** Checkpoint identifiers created for the run. */
  checkpointRefs: string[];
  /** Reference to the run transcript. */
  transcript: TranscriptRef;
  /** Reference to the persisted execution graph. */
  executionGraph?: ExecutionGraphRef;
  /** Transcript entries captured for replay/testing. */
  transcriptEntries: TranscriptEntry[];
  /** Bootstrap/setup report emitted for the runtime. */
  bootstrapReport: RuntimeBootstrapReport;
  /** Most recent approval state for the run. */
  approvalState: ApprovalStateSnapshot;
  /** Snapshot creation timestamp. */
  createdAt: number;
  /** Snapshot update timestamp. */
  updatedAt: number;
}

// ── Run ──

/** A run represents a full agent execution from input to completion. */
export interface Run {
  /** Unique run identifier */
  id: string;
  /** Agent definition ID this run belongs to */
  agentId: string;
  /** Current run state */
  state: RunState;
  /** Input that started this run */
  input: string;
  /** Turns executed so far */
  turns: Turn[];
  /** Normalized turn outcomes captured for replay and UI inspection. */
  turnOutcomes: TurnOutcome[];
  /** Final output (set when state=completed) */
  output?: string;
  /** Error message (set when state=failed) */
  error?: string;
  /** Run creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Total model usage across all turns */
  totalUsage: ModelUsage;
  /** Policy decisions made during the run. */
  policyDecisions: PolicyDecision[];
  /** Approval decisions made during the run. */
  approvalDecisions: ApprovalDecision[];
  /** Run metadata */
  metadata?: Record<string, unknown>;
}

// ── Turn ──

/** A turn represents one model call + action execution cycle. */
export interface Turn {
  /** Turn index (0-based) */
  index: number;
  /** Model input (compiled context) */
  input: string;
  /** Raw model output */
  modelOutput: string;
  /** Parsed proposal from model output */
  proposal: ActionProposal;
  /** Whether the proposal was approved by policies */
  approved: boolean;
  /** Result of executing the approved action */
  result?: unknown;
  /** Model usage for this turn */
  usage: ModelUsage;
  /** Turn timestamp */
  timestamp: number;
  /** Events emitted during this turn */
  events: TraceEvent[];
}

// ── Turn Result ──

/** Result of executing a single turn. */
export interface TurnResult {
  /** The turn that was executed */
  turn: Turn;
  /** Normalized runtime-facing outcome for the turn. */
  outcome: TurnOutcome;
  /** Updated run state after this turn */
  runState: RunState;
  /** Whether the run should continue */
  shouldContinue: boolean;
}

// ── Run Result ──

/** Final result of a completed run. */
export interface RunResult {
  /** The completed run */
  run: Run;
  /** Final output text */
  output: string;
  /** All events emitted during the run */
  events: TraceEvent[];
  /** Total model usage */
  usage: ModelUsage;
  /** Normalized turn outcomes captured during the run. */
  turnOutcomes: TurnOutcome[];
  /** Session/debug snapshot for the run. */
  session: RunSessionSnapshot;
  /** Replayable execution graph emitted during the run. */
  executionGraph?: ExecutionGraph | null;
  /** Bootstrap/setup report used for this runtime. */
  bootstrapReport: RuntimeBootstrapReport;
}

/** Approval or operator input used to resume a suspended run. */
export interface ResumeRunOptions {
  /** Optional approval resolution to apply before resuming. */
  approval?: {
    requestId?: string;
    approved: boolean;
    approver?: string;
    reason?: string;
  };
}

/** Serialized run payload stored in a checkpoint. */
export interface RunCheckpointState {
  /** Run snapshot at checkpoint time. */
  run: Run;
  /** Turn index reached when the checkpoint was created. */
  turnIndex: number;
  /** Transcript entries captured at checkpoint time. */
  transcriptEntries?: TranscriptEntry[];
}
