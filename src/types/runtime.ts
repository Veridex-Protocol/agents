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
}
