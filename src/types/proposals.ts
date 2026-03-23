/**
 * @packageDocumentation
 * @module ProposalTypes
 * @description
 * Action proposal types for the Veridex Agent Fabric.
 *
 * After each model call, the output is parsed into a discriminated
 * union of proposals: final answer, tool call, memory write,
 * handoff, or approval request.
 */

import type { ToolCall } from './tools';
import type { MemoryWriteRequest } from './memory';

// ── Proposal Types ──

/** Discriminator for action proposal types. */
export type ProposalType =
  | 'final_answer'
  | 'tool_call'
  | 'memory_write'
  | 'handoff'
  | 'approval_request';

// ── Base Proposal ──

interface BaseProposal {
  /** Proposal type discriminator */
  type: ProposalType;
}

// ── Specific Proposals ──

/** The model produced a final answer — the run should complete. */
export interface FinalAnswerProposal extends BaseProposal {
  type: 'final_answer';
  /** The final answer text */
  answer: string;
}

/** The model wants to call one or more tools. */
export interface ToolCallProposal extends BaseProposal {
  type: 'tool_call';
  /** The tool calls to execute */
  toolCalls: ToolCall[];
}

/** The model wants to write to memory. */
export interface MemoryWriteProposal extends BaseProposal {
  type: 'memory_write';
  /** The memory writes to perform */
  writes: MemoryWriteRequest[];
}

/** The model wants to hand off to another agent. */
export interface HandoffProposal extends BaseProposal {
  type: 'handoff';
  /** Target agent ID */
  targetAgentId: string;
  /** Reason for handoff */
  reason: string;
  /** Context to pass to the target agent */
  context?: string;
}

/** The model is requesting human approval for an action. */
export interface ApprovalRequestProposal extends BaseProposal {
  type: 'approval_request';
  /** What action needs approval */
  action: string;
  /** Why approval is needed */
  reason: string;
  /** Risk score (0-100) */
  riskScore: number;
  /** Details for the approver */
  details?: Record<string, unknown>;
}

// ── Discriminated Union ──

/** Discriminated union of all action proposal types. */
export type ActionProposal =
  | FinalAnswerProposal
  | ToolCallProposal
  | MemoryWriteProposal
  | HandoffProposal
  | ApprovalRequestProposal;
