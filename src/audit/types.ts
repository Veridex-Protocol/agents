/**
 * @packageDocumentation
 * @module TraceEnvelopeTypes
 * @description
 * Unified trace envelope types that bridge runtime audit (AuditEmitter / TraceEvent)
 * and SDK-level cryptographic evidence (TraceInterceptor / VeridexTracePayload).
 *
 * The envelope provides a single, hashable, signable evidence package that:
 * - Embeds run-level events (from the runtime event bus)
 * - Embeds decision-level reasoning traces (from the SDK trace layer)
 * - Uses a single hash algorithm (keccak256-compatible hex) for smart-contract binding
 * - Supports optional signature and storage receipt for decentralized archival
 * - Can be verified offline without access to the original signer
 */

import type { TraceEvent } from '../types/events';
import type { PolicyDecision } from '../types/policy';
import type { ModelUsage } from '../types/models';
import type { ApprovalDecision } from '../approvals/ApprovalManager';
import type { ToolExecutionSummary } from './AuditEmitter';

// ── Reasoning Snapshot ──

/**
 * Compact reasoning snapshot for a single decision point within a run.
 * Mirrors the SDK's ReasoningContext/VeridexTracePayload shape
 * without depending on the SDK package directly.
 */
export interface ReasoningSnapshot {
  /** Unique trace ID for this decision (UUID). */
  traceId: string;
  /** Turn index within the run where this decision occurred. */
  turnIndex: number;
  /** Prompt or instruction the model received. */
  prompt?: string;
  /** Model output / reasoning chain. */
  llmOutput?: string;
  /** Tool calls made as part of this decision. */
  toolCalls: Array<{
    tool: string;
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    timestamp: number;
  }>;
  /** Proposed action resulting from this reasoning. */
  proposedAction?: {
    type: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
  /** Policy evaluation result for this decision (if applicable). */
  policyVerdict?: {
    verdict: string;
    riskScore: number;
    reasons: string[];
  };
  /** Hash of this individual reasoning trace (if computed by SDK). */
  traceHash?: string;
  /** Signature over traceHash (if signed by session key). */
  signature?: string;
}

// ── Storage & Settlement ──

/** Receipt from persisting the envelope to decentralized or durable storage. */
export interface EnvelopeStorageReceipt {
  /** Storage provider name (e.g. 'arweave', 'filecoin', 'ipfs', 'postgres'). */
  provider: string;
  /** Content identifier returned by the storage backend. */
  contentId: string;
  /** Timestamp when stored. */
  storedAt: number;
  /** Whether the storage is immutable (content-addressed). */
  immutable: boolean;
}

/** On-chain settlement proof linking the envelope to a blockchain transaction. */
export interface EnvelopeSettlementProof {
  /** Transaction hash. */
  txHash: string;
  /** Block number (if confirmed). */
  blockNumber?: number;
  /** Whether the envelope hash was injected into calldata. */
  hashInCalldata: boolean;
  /** Chain ID (EIP-155). */
  chainId: number;
  /** Block explorer URL. */
  explorerUrl?: string;
}

// ── Unified Trace Envelope ──

/**
 * The unified trace envelope — a single evidence package that bridges
 * runtime audit events and SDK-level cryptographic reasoning traces.
 *
 * Design invariants:
 * - `contentHash` covers all non-meta fields deterministically
 * - `envelopeHash` covers the entire envelope including contentHash for tamper detection
 * - Both hashes use the same algorithm for consistency
 * - The envelope is JSON-serializable without loss
 */
export interface TraceEnvelope {
  /** Envelope format version for forward compatibility. */
  version: 1;

  // ── Identity ──
  /** Unique envelope ID. */
  id: string;
  /** Run ID this envelope covers. */
  runId: string;
  /** Agent ID. */
  agentId: string;

  // ── Timing ──
  /** Run start timestamp (epoch ms). */
  runStartedAt: number;
  /** Run end timestamp (epoch ms). */
  runEndedAt: number;
  /** Envelope assembly timestamp (epoch ms). */
  assembledAt: number;

  // ── Run Summary ──
  /** Final run state. */
  finalState: string;
  /** Aggregate model usage. */
  totalUsage: ModelUsage;
  /** Total spend in USD across all tools/models. */
  totalSpendUSD: number;
  /** Number of turns executed. */
  turnCount: number;

  // ── Event Sourcing ──
  /** All runtime trace events (chronological). */
  events: TraceEvent[];

  // ── Decision Traces ──
  /** Per-decision reasoning snapshots from the SDK trace layer. */
  reasoningTraces: ReasoningSnapshot[];

  // ── Governance Evidence ──
  /** Policy decisions made during the run. */
  policyDecisions: PolicyDecision[];
  /** Approval decisions made during the run. */
  approvalDecisions: ApprovalDecision[];
  /** Tool execution summaries. */
  toolExecutions: ToolExecutionSummary[];

  // ── Cryptographic Binding ──
  /** Hash of canonical content (hex string, 0x-prefixed or plain). */
  contentHash: string;
  /** Optional signature over contentHash by session key. */
  signature?: string;
  /** Signer address or public key identifier. */
  signerIdentity?: string;

  // ── Envelope Integrity ──
  /** Hash of the entire envelope (including contentHash) for tamper detection. */
  envelopeHash: string;

  // ── Storage & Settlement ──
  /** Storage receipt after archival. */
  storageReceipt?: EnvelopeStorageReceipt;
  /** On-chain settlement proof. */
  settlementProof?: EnvelopeSettlementProof;

  // ── Metadata ──
  /** Free-form metadata. */
  metadata?: Record<string, unknown>;
}

// ── Envelope Build Params ──

/** Parameters for assembling a trace envelope (before hashing). */
export interface TraceEnvelopeBuildParams {
  runId: string;
  agentId: string;
  runStartedAt: number;
  runEndedAt: number;
  finalState: string;
  totalUsage: ModelUsage;
  totalSpendUSD: number;
  turnCount: number;
  events: TraceEvent[];
  reasoningTraces?: ReasoningSnapshot[];
  policyDecisions: PolicyDecision[];
  approvalDecisions: ApprovalDecision[];
  toolExecutions: ToolExecutionSummary[];
  signature?: string;
  signerIdentity?: string;
  storageReceipt?: EnvelopeStorageReceipt;
  settlementProof?: EnvelopeSettlementProof;
  metadata?: Record<string, unknown>;
}

// ── Verification Result ──

export interface EnvelopeVerificationResult {
  /** Whether the content hash matches the canonical content. */
  contentValid: boolean;
  /** Whether the envelope hash matches the full envelope. */
  envelopeValid: boolean;
  /** Number of reasoning traces with valid individual hashes. */
  validTraceCount: number;
  /** Total reasoning traces checked. */
  totalTraceCount: number;
}
