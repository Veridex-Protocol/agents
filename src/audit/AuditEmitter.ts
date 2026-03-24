/**
 * @module AuditEmitter
 * Structured audit trace emitter and evidence packager.
 * Produces hashable, signable audit bundles from agent run traces.
 */

import type { TraceEvent } from '../types/events';
import type { PolicyDecision } from '../types/policy';
import type { ModelUsage } from '../types/models';
import type { ApprovalDecision } from '../approvals/ApprovalManager';

// ── Audit Types ──

/** A complete audit bundle for a single run. */
export interface AuditBundle {
  /** Unique bundle ID. */
  id: string;
  /** Run ID this bundle covers. */
  runId: string;
  /** Agent ID. */
  agentId: string;
  /** Bundle creation timestamp. */
  createdAt: number;
  /** Run start timestamp. */
  runStartedAt: number;
  /** Run end timestamp. */
  runEndedAt: number;
  /** Final run state. */
  finalState: string;
  /** Total model usage. */
  totalUsage: ModelUsage;
  /** Total spend in USD. */
  totalSpendUSD: number;
  /** Number of turns executed. */
  turnCount: number;
  /** All trace events from the run. */
  events: TraceEvent[];
  /** Policy decisions made during the run. */
  policyDecisions: PolicyDecision[];
  /** Approval decisions made during the run. */
  approvalDecisions: ApprovalDecision[];
  /** Tool executions summary. */
  toolExecutions: ToolExecutionSummary[];
  /** Content hash (SHA-256 hex) of the canonical bundle. */
  contentHash: string;
  /** Optional signature over the content hash. */
  signature?: string;
  /** Bundle metadata. */
  metadata?: Record<string, unknown>;
}

/** Summary of a single tool execution for audit. */
export interface ToolExecutionSummary {
  toolName: string;
  turnIndex: number;
  success: boolean;
  durationMs: number;
  error?: string;
  costUSD?: number;
}

/** Audit export format. */
export type AuditExportFormat = 'json' | 'jsonl' | 'csv';

/** Sink for audit bundles. */
export interface AuditSink {
  /** Sink identifier. */
  id: string;
  /** Write a bundle to this sink. */
  write(bundle: AuditBundle): Promise<void>;
}

// ── In-Memory Sink ──

export class InMemoryAuditSink implements AuditSink {
  readonly id = 'in-memory';
  private bundles: AuditBundle[] = [];

  async write(bundle: AuditBundle): Promise<void> {
    this.bundles.push(bundle);
  }

  getAll(): AuditBundle[] {
    return [...this.bundles];
  }

  getByRunId(runId: string): AuditBundle | undefined {
    return this.bundles.find((b) => b.runId === runId);
  }

  getByAgentId(agentId: string): AuditBundle[] {
    return this.bundles.filter((b) => b.agentId === agentId);
  }

  clear(): void {
    this.bundles = [];
  }
}

// ── Audit Emitter ──

export class AuditEmitter {
  private sinks: AuditSink[] = [];
  private bundleCounter = 0;

  /** Register an audit sink. */
  addSink(sink: AuditSink): void {
    this.sinks.push(sink);
  }

  /** Remove a sink by ID. */
  removeSink(sinkId: string): boolean {
    const idx = this.sinks.findIndex((s) => s.id === sinkId);
    if (idx === -1) return false;
    this.sinks.splice(idx, 1);
    return true;
  }

  /** List registered sinks. */
  listSinks(): AuditSink[] {
    return [...this.sinks];
  }

  /**
   * Build and emit an audit bundle from run data.
   * Computes content hash and writes to all registered sinks.
   */
  async emit(params: {
    runId: string;
    agentId: string;
    runStartedAt: number;
    runEndedAt: number;
    finalState: string;
    totalUsage: ModelUsage;
    totalSpendUSD: number;
    turnCount: number;
    events: TraceEvent[];
    policyDecisions: PolicyDecision[];
    approvalDecisions: ApprovalDecision[];
    toolExecutions: ToolExecutionSummary[];
    metadata?: Record<string, unknown>;
  }): Promise<AuditBundle> {
    const bundleId = `audit_${++this.bundleCounter}_${Date.now()}`;

    // Build canonical content for hashing
    const canonical = JSON.stringify({
      runId: params.runId,
      agentId: params.agentId,
      runStartedAt: params.runStartedAt,
      runEndedAt: params.runEndedAt,
      finalState: params.finalState,
      totalUsage: params.totalUsage,
      turnCount: params.turnCount,
      events: params.events,
      policyDecisions: params.policyDecisions,
      approvalDecisions: params.approvalDecisions,
      toolExecutions: params.toolExecutions,
    });

    const contentHash = await this.computeHash(canonical);

    const bundle: AuditBundle = {
      id: bundleId,
      runId: params.runId,
      agentId: params.agentId,
      createdAt: Date.now(),
      runStartedAt: params.runStartedAt,
      runEndedAt: params.runEndedAt,
      finalState: params.finalState,
      totalUsage: params.totalUsage,
      totalSpendUSD: params.totalSpendUSD,
      turnCount: params.turnCount,
      events: params.events,
      policyDecisions: params.policyDecisions,
      approvalDecisions: params.approvalDecisions,
      toolExecutions: params.toolExecutions,
      contentHash,
      metadata: params.metadata,
    };

    // Write to all sinks
    const writePromises = this.sinks.map(async (sink) => {
      try {
        await sink.write(bundle);
      } catch (err) {
        // Audit sink failures should not crash the runtime
        console.error(`Audit sink '${sink.id}' failed:`, err);
      }
    });

    await Promise.all(writePromises);

    return bundle;
  }

  /**
   * Export audit bundles in a specific format.
   */
  exportBundles(bundles: AuditBundle[], format: AuditExportFormat): string {
    switch (format) {
      case 'json':
        return JSON.stringify(bundles, null, 2);
      case 'jsonl':
        return bundles.map((b) => JSON.stringify(b)).join('\n');
      case 'csv': {
        const header = 'id,runId,agentId,createdAt,finalState,turnCount,totalSpendUSD,contentHash';
        const rows = bundles.map((b) =>
          `${b.id},${b.runId},${b.agentId},${b.createdAt},${b.finalState},${b.turnCount},${b.totalSpendUSD},${b.contentHash}`,
        );
        return [header, ...rows].join('\n');
      }
    }
  }

  /** Compute SHA-256 hash of content. Uses Web Crypto when available, falls back to simple hash. */
  private async computeHash(content: string): Promise<string> {
    try {
      // Use Web Crypto API (available in Node 18+ and browsers)
      const encoder = new TextEncoder();
      const data = encoder.encode(content);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fallback: simple deterministic hash for environments without Web Crypto
      let hash = 0;
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash + char) | 0;
      }
      return Math.abs(hash).toString(16).padStart(8, '0');
    }
  }

  /**
   * Verify the integrity of an audit bundle by recomputing its content hash.
   */
  async verifyBundle(bundle: AuditBundle): Promise<boolean> {
    const canonical = JSON.stringify({
      runId: bundle.runId,
      agentId: bundle.agentId,
      runStartedAt: bundle.runStartedAt,
      runEndedAt: bundle.runEndedAt,
      finalState: bundle.finalState,
      totalUsage: bundle.totalUsage,
      turnCount: bundle.turnCount,
      events: bundle.events,
      policyDecisions: bundle.policyDecisions,
      approvalDecisions: bundle.approvalDecisions,
      toolExecutions: bundle.toolExecutions,
    });

    const computed = await this.computeHash(canonical);
    return computed === bundle.contentHash;
  }
}
