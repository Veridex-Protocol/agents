/**
 * @packageDocumentation
 * @module AccountabilityTypes
 * @description
 * Durable accountability primitives for the Veridex Agent Fabric.
 *
 * These types back replayable execution graphs, run/thread persistence,
 * side-effect receipts, and governed memory validation.
 */

import type { RuntimeBootstrapReport } from './bootstrap';
import type { ContextPlanSummary, Run } from './runtime';
import type { TranscriptRef } from './transcript';
import type {
  MemoryEntry,
  MemoryEntryKind,
  MemoryEvidenceReference,
  MemoryWriteRequest,
} from './memory';

export type IdempotencyKey = string;

export type ExecutionPhase =
  | 'proposal'
  | 'validation'
  | 'policy'
  | 'approval'
  | 'execution'
  | 'mutation'
  | 'receipt'
  | 'evidence'
  | 'checkpoint'
  | 'completion';

export type ExecutionNodeKind =
  | 'actor'
  | 'proposal'
  | 'policy_decision'
  | 'approval'
  | 'capability'
  | 'resource_mutation'
  | 'side_effect_receipt'
  | 'evidence_bundle'
  | 'checkpoint'
  | 'completion';

export type ExecutionNodeStatus =
  | 'pending'
  | 'success'
  | 'failure'
  | 'blocked'
  | 'skipped';

export type ExecutionEdgeRelation =
  | 'triggered'
  | 'validated_by'
  | 'approved_by'
  | 'invoked'
  | 'mutates'
  | 'recorded_as'
  | 'follows';

export type ToolExecutionOutcome =
  | 'success'
  | 'transient_failure'
  | 'permanent_failure'
  | 'approval_blocked'
  | 'policy_blocked'
  | 'idempotent_skip';

export interface ActorRef {
  type: 'agent' | 'model' | 'tool' | 'operator' | 'system' | 'remote_agent';
  id: string;
  label?: string;
  sourceSessionId?: string;
  sourceThreadId?: string;
}

export interface ResourceRef {
  resourceType: string;
  resourceId: string;
  workspaceId?: string;
  tenantId?: string;
  version?: string | number;
}

export interface SideEffectReceipt {
  id: string;
  runId: string;
  turnIndex: number;
  capabilityName: string;
  idempotencyKey: IdempotencyKey;
  status: 'recorded' | 'skipped' | 'failed';
  externalReceiptId?: string;
  evidence?: MemoryEvidenceReference[];
  resource?: ResourceRef;
  receiptHash?: string;
  summary: string;
  metadata?: Record<string, unknown>;
  recordedAt: number;
}

export interface ExecutionNode {
  id: string;
  runId: string;
  turnIndex?: number;
  kind: ExecutionNodeKind;
  phase: ExecutionPhase;
  actor?: ActorRef;
  resource?: ResourceRef;
  proposalType?: string;
  capabilityName?: string;
  status: ExecutionNodeStatus;
  summary: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface ExecutionEdge {
  id: string;
  runId: string;
  from: string;
  to: string;
  relation: ExecutionEdgeRelation;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionGraph {
  runId: string;
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
  receipts: SideEffectReceipt[];
  createdAt: number;
  updatedAt: number;
}

export interface ExecutionGraphRef {
  runId: string;
  nodeCount: number;
  edgeCount: number;
  receiptCount: number;
  updatedAt?: number;
}

export interface StoredRunRecord {
  run: Run;
  latestContextSummary?: ContextPlanSummary;
  sessionSnapshot?: {
    updatedAt: number;
    transcript?: TranscriptRef;
    executionGraph?: ExecutionGraphRef;
  };
  transcript?: TranscriptRef;
  bootstrapReport?: RuntimeBootstrapReport;
  updatedAt: number;
}

export interface ThreadRecord {
  id: string;
  runId: string;
  agentId: string;
  title: string;
  state: Run['state'];
  transcript?: TranscriptRef;
  executionGraph?: ExecutionGraphRef;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface RunStore {
  read(runId: string): Promise<StoredRunRecord | null>;
  write(record: StoredRunRecord): Promise<StoredRunRecord>;
  list(filter?: {
    agentId?: string;
    state?: Run['state'];
    limit?: number;
  }): Promise<StoredRunRecord[]>;
  delete(runId: string): Promise<boolean>;
}

export interface ThreadStore {
  read(threadId: string): Promise<ThreadRecord | null>;
  write(record: ThreadRecord): Promise<ThreadRecord>;
  list(filter?: {
    agentId?: string;
    state?: Run['state'];
    limit?: number;
  }): Promise<ThreadRecord[]>;
  delete(threadId: string): Promise<boolean>;
}

export interface ExecutionGraphStore {
  appendNode(node: ExecutionNode): Promise<ExecutionNode>;
  appendEdge(edge: ExecutionEdge): Promise<ExecutionEdge>;
  recordReceipt(receipt: SideEffectReceipt): Promise<SideEffectReceipt>;
  getGraph(runId: string): Promise<ExecutionGraph | null>;
  getRef(runId: string): Promise<ExecutionGraphRef>;
  findReceiptByIdempotencyKey(
    runId: string,
    idempotencyKey: IdempotencyKey,
  ): Promise<SideEffectReceipt | null>;
  clear(runId?: string): Promise<void>;
}

export type MemoryRecordKind = MemoryEntryKind | 'authoritative_state';

export type EvidenceRef = MemoryEvidenceReference;

export interface MemoryProposal {
  kind: MemoryRecordKind;
  request: MemoryWriteRequest;
  reason?: string;
  evidence?: EvidenceRef[];
  runId?: string;
  turnIndex?: number;
}

export type MemoryValidationIssueCode =
  | 'dedup'
  | 'secrecy'
  | 'conflict'
  | 'staleness'
  | 'confidence';

export interface MemoryValidationIssue {
  code: MemoryValidationIssueCode;
  severity: 'info' | 'warn' | 'error';
  message: string;
}

export interface MemoryProposalValidationResult {
  accepted: boolean;
  issues: MemoryValidationIssue[];
  normalizedProposal?: MemoryProposal;
}

export interface MemoryProposalValidator {
  validate(
    proposal: MemoryProposal,
    context: {
      existingEntries: MemoryEntry[];
    },
  ): Promise<MemoryProposalValidationResult>;
}

export interface BrowserSessionRef {
  sessionId: string;
  provider?: string;
  workspaceId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
}

export interface BrowserArtifactRef {
  artifactId: string;
  kind: 'screenshot' | 'html' | 'pdf' | 'trace' | 'video' | 'selector_cache' | 'code_cache';
  uri?: string;
  contentHash?: string;
}

export interface BrowserCapabilityMetadata {
  persistentSession?: BrowserSessionRef;
  artifacts?: BrowserArtifactRef[];
  selectorCacheKey?: string;
  codeCacheKey?: string;
}
