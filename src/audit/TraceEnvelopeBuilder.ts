/**
 * @packageDocumentation
 * @module TraceEnvelopeBuilder
 * @description
 * Assembles, hashes, and verifies unified trace envelopes.
 * Uses deterministic canonical JSON for reproducible hashing.
 */

import type {
  TraceEnvelope,
  TraceEnvelopeBuildParams,
  EnvelopeVerificationResult,
  ReasoningSnapshot,
} from './types';

let envelopeCounter = 0;

function generateEnvelopeId(): string {
  envelopeCounter++;
  return `env_${Date.now()}_${envelopeCounter}`;
}

/**
 * Builds unified trace envelopes with deterministic hashing and verification.
 *
 * The hash algorithm is configurable via constructor, defaulting to SHA-256
 * via Web Crypto. For Ethereum-compatible keccak256, inject a custom hasher.
 */
export class TraceEnvelopeBuilder {
  private readonly hasher: (content: string) => Promise<string>;

  constructor(options?: {
    /** Custom hash function. Receives canonical JSON string, returns hex hash. */
    hasher?: (content: string) => Promise<string>;
  }) {
    this.hasher = options?.hasher ?? TraceEnvelopeBuilder.sha256Hash;
  }

  /**
   * Build a complete trace envelope from run data.
   */
  async build(params: TraceEnvelopeBuildParams): Promise<TraceEnvelope> {
    const id = generateEnvelopeId();
    const assembledAt = Date.now();

    // Compute content hash over canonical fields
    const canonicalContent = this.canonicalizeContent(params);
    const contentHash = await this.hasher(canonicalContent);

    // Build envelope without envelope hash first
    const partial: Omit<TraceEnvelope, 'envelopeHash'> = {
      version: 1,
      id,
      runId: params.runId,
      agentId: params.agentId,
      runStartedAt: params.runStartedAt,
      runEndedAt: params.runEndedAt,
      assembledAt,
      finalState: params.finalState,
      totalUsage: params.totalUsage,
      totalSpendUSD: params.totalSpendUSD,
      turnCount: params.turnCount,
      events: params.events,
      reasoningTraces: params.reasoningTraces ?? [],
      policyDecisions: params.policyDecisions,
      approvalDecisions: params.approvalDecisions,
      toolExecutions: params.toolExecutions,
      contentHash,
      signature: params.signature,
      signerIdentity: params.signerIdentity,
      storageReceipt: params.storageReceipt,
      settlementProof: params.settlementProof,
      metadata: params.metadata,
    };

    // Compute envelope hash over all fields (including contentHash)
    const envelopeCanonical = this.canonicalizeEnvelope(partial);
    const envelopeHash = await this.hasher(envelopeCanonical);

    return { ...partial, envelopeHash };
  }

  /**
   * Verify the integrity of a trace envelope.
   * Checks content hash, envelope hash, and individual reasoning trace hashes.
   */
  async verify(envelope: TraceEnvelope): Promise<EnvelopeVerificationResult> {
    // Verify content hash
    const params: TraceEnvelopeBuildParams = {
      runId: envelope.runId,
      agentId: envelope.agentId,
      runStartedAt: envelope.runStartedAt,
      runEndedAt: envelope.runEndedAt,
      finalState: envelope.finalState,
      totalUsage: envelope.totalUsage,
      totalSpendUSD: envelope.totalSpendUSD,
      turnCount: envelope.turnCount,
      events: envelope.events,
      reasoningTraces: envelope.reasoningTraces,
      policyDecisions: envelope.policyDecisions,
      approvalDecisions: envelope.approvalDecisions,
      toolExecutions: envelope.toolExecutions,
    };

    const canonical = this.canonicalizeContent(params);
    const recomputedContentHash = await this.hasher(canonical);
    const contentValid = recomputedContentHash === envelope.contentHash;

    // Verify envelope hash
    const { envelopeHash: _, ...partial } = envelope;
    const envelopeCanonical = this.canonicalizeEnvelope(partial);
    const recomputedEnvelopeHash = await this.hasher(envelopeCanonical);
    const envelopeValid = recomputedEnvelopeHash === envelope.envelopeHash;

    // Verify individual reasoning trace hashes (if they have traceHash set)
    let validTraceCount = 0;
    const tracesWithHash = envelope.reasoningTraces.filter((t) => t.traceHash);
    for (const trace of tracesWithHash) {
      const traceCanonical = this.canonicalizeReasoningTrace(trace);
      const computed = await this.hasher(traceCanonical);
      if (computed === trace.traceHash) {
        validTraceCount++;
      }
    }

    return {
      contentValid,
      envelopeValid,
      validTraceCount,
      totalTraceCount: tracesWithHash.length,
    };
  }

  /**
   * Hash a single reasoning trace using the same algorithm.
   * Useful for SDK-level trace capture that later gets embedded in an envelope.
   */
  async hashReasoningTrace(trace: ReasoningSnapshot): Promise<string> {
    const canonical = this.canonicalizeReasoningTrace(trace);
    return this.hasher(canonical);
  }

  // ── Canonicalization ──

  /**
   * Canonical content for the content hash — covers all evidence fields
   * but excludes metadata, signature, storage receipt, settlement proof.
   */
  private canonicalizeContent(params: TraceEnvelopeBuildParams): string {
    return canonicalJson({
      runId: params.runId,
      agentId: params.agentId,
      runStartedAt: params.runStartedAt,
      runEndedAt: params.runEndedAt,
      finalState: params.finalState,
      totalUsage: params.totalUsage,
      totalSpendUSD: params.totalSpendUSD,
      turnCount: params.turnCount,
      events: params.events,
      reasoningTraces: params.reasoningTraces ?? [],
      policyDecisions: params.policyDecisions,
      approvalDecisions: params.approvalDecisions,
      toolExecutions: params.toolExecutions,
    });
  }

  /**
   * Canonical envelope content — covers everything except envelopeHash itself.
   */
  private canonicalizeEnvelope(partial: Omit<TraceEnvelope, 'envelopeHash'>): string {
    return canonicalJson(partial);
  }

  /**
   * Canonical reasoning trace content — used for per-decision hashing.
   */
  private canonicalizeReasoningTrace(trace: ReasoningSnapshot): string {
    return canonicalJson({
      traceId: trace.traceId,
      turnIndex: trace.turnIndex,
      prompt: trace.prompt,
      llmOutput: trace.llmOutput,
      toolCalls: trace.toolCalls,
      proposedAction: trace.proposedAction,
      policyVerdict: trace.policyVerdict,
    });
  }

  // ── Default Hash Implementation ──

  /** SHA-256 hash using Web Crypto API with fallback. */
  static async sha256Hash(content: string): Promise<string> {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(content);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fallback for environments without Web Crypto
      let hash = 0;
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash + char) | 0;
      }
      return Math.abs(hash).toString(16).padStart(8, '0');
    }
  }
}

// ── Canonical JSON ──

/**
 * Deterministic JSON serialization with sorted keys.
 * Handles BigInt → string conversion.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return val.toString();
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}
