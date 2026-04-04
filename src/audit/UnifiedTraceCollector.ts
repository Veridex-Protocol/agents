/**
 * @packageDocumentation
 * @module UnifiedTraceCollector
 * @description
 * Collects runtime events and SDK reasoning traces during a run,
 * then assembles them into a unified TraceEnvelope via the builder.
 *
 * Sits between the runtime (which emits TraceEvents) and the SDK
 * (which captures ReasoningSnapshots) — unifying both into one evidence package.
 */

import type { TraceEvent } from '../types/events';
import type { PolicyDecision } from '../types/policy';
import type { ModelUsage } from '../types/models';
import type { ApprovalDecision } from '../approvals/ApprovalManager';
import type { ToolExecutionSummary } from './AuditEmitter';
import type {
  TraceEnvelope,
  ReasoningSnapshot,
  EnvelopeStorageReceipt,
  EnvelopeSettlementProof,
} from './types';
import { TraceEnvelopeBuilder } from './TraceEnvelopeBuilder';

/** Sink that receives unified trace envelopes. */
export interface EnvelopeSink {
  id: string;
  write(envelope: TraceEnvelope): Promise<void>;
}

/** In-memory envelope sink for testing and inspection. */
export class InMemoryEnvelopeSink implements EnvelopeSink {
  readonly id = 'in-memory-envelope';
  private envelopes: TraceEnvelope[] = [];

  async write(envelope: TraceEnvelope): Promise<void> {
    this.envelopes.push(envelope);
  }

  getAll(): TraceEnvelope[] {
    return [...this.envelopes];
  }

  getByRunId(runId: string): TraceEnvelope | undefined {
    return this.envelopes.find((e) => e.runId === runId);
  }

  getByAgentId(agentId: string): TraceEnvelope[] {
    return this.envelopes.filter((e) => e.agentId === agentId);
  }

  clear(): void {
    this.envelopes = [];
  }
}

export interface UnifiedTraceCollectorOptions {
  /** Custom hasher for envelope building. */
  hasher?: (content: string) => Promise<string>;
  /** Sinks to write envelopes to. */
  sinks?: EnvelopeSink[];
}

/**
 * Collects trace data during a run, then flushes a unified envelope.
 *
 * Usage:
 * ```ts
 * const collector = new UnifiedTraceCollector('run-1', 'agent-1');
 * collector.addEvent(event);
 * collector.addReasoningTrace(trace);
 * collector.addPolicyDecision(decision);
 * const envelope = await collector.flush({ finalState: 'completed', ... });
 * ```
 */
export class UnifiedTraceCollector {
  private readonly builder: TraceEnvelopeBuilder;
  private readonly sinks: EnvelopeSink[] = [];

  private readonly runId: string;
  private readonly agentId: string;
  private readonly runStartedAt: number;

  private events: TraceEvent[] = [];
  private reasoningTraces: ReasoningSnapshot[] = [];
  private policyDecisions: PolicyDecision[] = [];
  private approvalDecisions: ApprovalDecision[] = [];
  private toolExecutions: ToolExecutionSummary[] = [];
  private totalUsage: ModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private totalSpendUSD = 0;

  constructor(
    runId: string,
    agentId: string,
    options?: UnifiedTraceCollectorOptions,
  ) {
    this.runId = runId;
    this.agentId = agentId;
    this.runStartedAt = Date.now();
    this.builder = new TraceEnvelopeBuilder({ hasher: options?.hasher });
    if (options?.sinks) {
      this.sinks.push(...options.sinks);
    }
  }

  // ── Collection Methods ──

  addEvent(event: TraceEvent): void {
    this.events.push(event);
  }

  addEvents(events: TraceEvent[]): void {
    this.events.push(...events);
  }

  addReasoningTrace(trace: ReasoningSnapshot): void {
    this.reasoningTraces.push(trace);
  }

  addPolicyDecision(decision: PolicyDecision): void {
    this.policyDecisions.push(decision);
  }

  addApprovalDecision(decision: ApprovalDecision): void {
    this.approvalDecisions.push(decision);
  }

  addToolExecution(execution: ToolExecutionSummary): void {
    this.toolExecutions.push(execution);
  }

  addUsage(usage: ModelUsage): void {
    this.totalUsage = {
      inputTokens: this.totalUsage.inputTokens + usage.inputTokens,
      outputTokens: this.totalUsage.outputTokens + usage.outputTokens,
      totalTokens: this.totalUsage.totalTokens + usage.totalTokens,
    };
  }

  addSpend(usd: number): void {
    this.totalSpendUSD += usd;
  }

  // ── Sink Management ──

  addSink(sink: EnvelopeSink): void {
    this.sinks.push(sink);
  }

  removeSink(sinkId: string): boolean {
    const idx = this.sinks.findIndex((s) => s.id === sinkId);
    if (idx === -1) return false;
    this.sinks.splice(idx, 1);
    return true;
  }

  // ── Flush ──

  /**
   * Assemble, hash, and emit a unified trace envelope.
   * Writes to all registered sinks.
   */
  async flush(params: {
    finalState: string;
    turnCount: number;
    signature?: string;
    signerIdentity?: string;
    storageReceipt?: EnvelopeStorageReceipt;
    settlementProof?: EnvelopeSettlementProof;
    metadata?: Record<string, unknown>;
  }): Promise<TraceEnvelope> {
    const envelope = await this.builder.build({
      runId: this.runId,
      agentId: this.agentId,
      runStartedAt: this.runStartedAt,
      runEndedAt: Date.now(),
      finalState: params.finalState,
      totalUsage: this.totalUsage,
      totalSpendUSD: this.totalSpendUSD,
      turnCount: params.turnCount,
      events: this.events,
      reasoningTraces: this.reasoningTraces,
      policyDecisions: this.policyDecisions,
      approvalDecisions: this.approvalDecisions,
      toolExecutions: this.toolExecutions,
      signature: params.signature,
      signerIdentity: params.signerIdentity,
      storageReceipt: params.storageReceipt,
      settlementProof: params.settlementProof,
      metadata: params.metadata,
    });

    // Write to all sinks (non-blocking errors)
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.write(envelope);
        } catch (err) {
          console.error(`Envelope sink '${sink.id}' failed:`, err);
        }
      }),
    );

    return envelope;
  }

  // ── Introspection ──

  /** Current event count. */
  get eventCount(): number {
    return this.events.length;
  }

  /** Current reasoning trace count. */
  get traceCount(): number {
    return this.reasoningTraces.length;
  }

  /** Get the builder for standalone hashing/verification. */
  getBuilder(): TraceEnvelopeBuilder {
    return this.builder;
  }
}
