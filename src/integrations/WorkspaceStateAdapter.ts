/**
 * @packageDocumentation
 * @module WorkspaceStateAdapter
 * @description
 * Typed adapter for reading governed workspace state from an
 * external authority (control plane, database, or remote service).
 *
 * The runtime never owns workspace state — it only reads it during
 * context assembly and proposes mutations through the adapter. The
 * actual persistence and access control live outside the runtime.
 */

import type { MemoryStateReference, MemoryEvidenceReference } from '../types/memory';

/** A snapshot of a single workspace resource for context injection. */
export interface WorkspaceResourceSnapshot {
  /** The state reference that produced this snapshot. */
  ref: MemoryStateReference;
  /** Human-readable summary suitable for context assembly. */
  summary: string;
  /** ISO timestamp of the authoritative record. */
  asOf: string;
  /** Optional structured data (not injected into prompt directly). */
  data?: Record<string, unknown>;
}

/** A snapshot of evidence for context injection. */
export interface EvidenceSnapshot {
  /** The evidence reference that produced this snapshot. */
  ref: MemoryEvidenceReference;
  /** Human-readable summary. */
  summary: string;
}

/** Options for querying workspace state. */
export interface WorkspaceStateQuery {
  resourceTypes?: string[];
  resourceIds?: string[];
  limit?: number;
}

/** Options for querying evidence. */
export interface EvidenceQuery {
  traceIds?: string[];
  bundleIds?: string[];
  limit?: number;
}

/** A mutation the runtime proposes against workspace state. */
export interface WorkspaceStateMutation {
  /** The resource to mutate. */
  ref: MemoryStateReference;
  /** Optional workspace scope for the mutation. */
  workspaceId?: string;
  /** Type of mutation. */
  operation: 'create' | 'update' | 'delete';
  /** Payload for create/update (schema depends on resourceType). */
  payload?: Record<string, unknown>;
  /** Reason the runtime is requesting this mutation. */
  reason: string;
  /** Expected resource version for optimistic concurrency. */
  expectedVersion?: string;
  /** Idempotency key for resume-safe mutation handling. */
  idempotencyKey?: string;
  /** Supporting evidence references. */
  evidence?: MemoryEvidenceReference[];
  /** Proposed actor identifier. */
  proposedBy?: string;
}

/** Result of a proposed mutation. */
export interface WorkspaceStateMutationResult {
  /** Whether the mutation was accepted. */
  accepted: boolean;
  /** Reason for rejection, if any. */
  rejectionReason?: string;
  /** Updated resource snapshot, if accepted. */
  snapshot?: WorkspaceResourceSnapshot;
}

/**
 * Interface for workspace state adapters.
 *
 * Implementations connect the agent runtime to an authoritative
 * state store. The simplest implementation returns empty arrays
 * (no external state). Production implementations would talk to
 * the control-plane service or a resource catalog.
 */
export interface WorkspaceStateProvider {
  /** Fetch current workspace resource snapshots. */
  getResources(query?: WorkspaceStateQuery): Promise<WorkspaceResourceSnapshot[]>;
  /** Fetch evidence snapshots. */
  getEvidence(query?: EvidenceQuery): Promise<EvidenceSnapshot[]>;
  /** Propose a state mutation. Returns acceptance/rejection. */
  proposeMutation(mutation: WorkspaceStateMutation): Promise<WorkspaceStateMutationResult>;
}

export class WorkspaceStateAdapter {
  private provider: WorkspaceStateProvider;

  constructor(provider: WorkspaceStateProvider) {
    this.provider = provider;
  }

  isAvailable(): boolean {
    return this.provider != null;
  }

  async getResources(query?: WorkspaceStateQuery): Promise<WorkspaceResourceSnapshot[]> {
    return this.provider.getResources(query);
  }

  async getEvidence(query?: EvidenceQuery): Promise<EvidenceSnapshot[]> {
    return this.provider.getEvidence(query);
  }

  async proposeMutation(mutation: WorkspaceStateMutation): Promise<WorkspaceStateMutationResult> {
    return this.provider.proposeMutation(mutation);
  }
}
