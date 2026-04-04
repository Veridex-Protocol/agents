/**
 * @packageDocumentation
 * @module RemoteCallTracer
 * @description
 * Records provenance for every remote transport call — who called what,
 * via which protocol, how long it took, outcome, cost, and retry info.
 */

import type { CircuitBreakerState, RemoteCallOutcome, RemoteCallRecord } from './types';

let callCounter = 0;

function generateCallId(): string {
  callCounter++;
  return `rc_${Date.now()}_${callCounter}`;
}

export interface RemoteCallTracerOptions {
  /** Maximum number of records to retain in memory (0 = unlimited). */
  maxRecords?: number;
}

export interface StartCallParams {
  capability: string;
  protocol: 'mcp' | 'acp' | 'a2a';
  endpoint: string;
  callerAgentId: string;
  callerRunId: string;
  authMethod?: 'bearer' | 'api-key' | 'none';
  circuitState?: CircuitBreakerState;
}

export interface FinishCallParams {
  callId: string;
  outcome: RemoteCallOutcome;
  attempts: number;
  costUSD?: number;
  error?: string;
  httpStatus?: number;
}

/**
 * In-memory provenance recorder for remote transport calls.
 * Tracks start/finish semantics with timing, cost, and outcome.
 */
export class RemoteCallTracer {
  private readonly records = new Map<string, RemoteCallRecord>();
  private readonly insertionOrder: string[] = [];
  private readonly maxRecords: number;

  constructor(options?: RemoteCallTracerOptions) {
    this.maxRecords = options?.maxRecords ?? 0;
  }

  /** Begin tracking a remote call. Returns the call ID. */
  startCall(params: StartCallParams): string {
    const callId = generateCallId();
    const record: RemoteCallRecord = {
      callId,
      capability: params.capability,
      protocol: params.protocol,
      endpoint: params.endpoint,
      callerAgentId: params.callerAgentId,
      callerRunId: params.callerRunId,
      outcome: 'success', // placeholder until finished
      attempts: 0,
      startedAt: Date.now(),
      durationMs: 0,
      authMethod: params.authMethod,
      circuitState: params.circuitState,
    };

    this.records.set(callId, record);
    this.insertionOrder.push(callId);
    this.evictIfNeeded();

    return callId;
  }

  /** Finish a tracked call with outcome details. */
  finishCall(params: FinishCallParams): RemoteCallRecord | undefined {
    const record = this.records.get(params.callId);
    if (!record) return undefined;

    record.outcome = params.outcome;
    record.attempts = params.attempts;
    record.durationMs = Date.now() - record.startedAt;
    record.costUSD = params.costUSD;
    record.error = params.error;
    record.httpStatus = params.httpStatus;

    return { ...record };
  }

  /** Get a specific call record. */
  getCall(callId: string): RemoteCallRecord | undefined {
    const record = this.records.get(callId);
    return record ? { ...record } : undefined;
  }

  /** Get all records, newest first. */
  getAll(): RemoteCallRecord[] {
    return [...this.insertionOrder]
      .reverse()
      .map((id) => this.records.get(id)!)
      .filter(Boolean)
      .map((r) => ({ ...r }));
  }

  /** Get records for a specific capability. */
  getByCapability(capability: string): RemoteCallRecord[] {
    return this.getAll().filter((r) => r.capability === capability);
  }

  /** Get records for a specific caller agent. */
  getByAgent(agentId: string): RemoteCallRecord[] {
    return this.getAll().filter((r) => r.callerAgentId === agentId);
  }

  /** Summary statistics across all tracked calls. */
  summary(): {
    total: number;
    byOutcome: Record<string, number>;
    byProtocol: Record<string, number>;
    totalCostUSD: number;
    avgDurationMs: number;
  } {
    const records = this.getAll();
    const byOutcome: Record<string, number> = {};
    const byProtocol: Record<string, number> = {};
    let totalCost = 0;
    let totalDuration = 0;

    for (const r of records) {
      byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
      byProtocol[r.protocol] = (byProtocol[r.protocol] ?? 0) + 1;
      totalCost += r.costUSD ?? 0;
      totalDuration += r.durationMs;
    }

    return {
      total: records.length,
      byOutcome,
      byProtocol,
      totalCostUSD: totalCost,
      avgDurationMs: records.length > 0 ? totalDuration / records.length : 0,
    };
  }

  /** Clear all records. */
  clear(): void {
    this.records.clear();
    this.insertionOrder.length = 0;
  }

  /** Current record count. */
  get size(): number {
    return this.records.size;
  }

  private evictIfNeeded(): void {
    if (this.maxRecords <= 0) return;
    while (this.insertionOrder.length > this.maxRecords) {
      const oldest = this.insertionOrder.shift();
      if (oldest) this.records.delete(oldest);
    }
  }
}
