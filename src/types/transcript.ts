/**
 * @packageDocumentation
 * @module TranscriptTypes
 * @description
 * Append-only transcript types for replay, debugging, and checkpoint restore.
 *
 * Transcripts are intentionally separate from memory and workspace state.
 * They preserve what happened during a run without becoming the system of record.
 */

// ── Transcript Kinds ──

export type TranscriptEntryKind =
  | 'user_input'
  | 'model_output'
  | 'tool_call'
  | 'tool_result'
  | 'policy_decision'
  | 'approval_event'
  | 'handoff'
  | 'system_note';

export type TranscriptStoreMode = 'memory' | 'file';

// ── Transcript Entries ──

export interface TranscriptEntry {
  /** Unique transcript entry identifier. */
  id: string;
  /** Run this entry belongs to. */
  runId: string;
  /** Agent this entry belongs to. */
  agentId: string;
  /** Entry kind. */
  kind: TranscriptEntryKind;
  /** Timestamp when the entry was recorded. */
  timestamp: number;
  /** Turn index if the entry is associated with a turn. */
  turnIndex?: number;
  /** Human-readable content for replay/debugging. */
  content: string;
  /** Optional structured metadata. */
  metadata?: Record<string, unknown>;
}

export interface TranscriptReplayOptions {
  /** Filter to specific transcript kinds. */
  kinds?: TranscriptEntryKind[];
  /** Filter to transcript entries after this timestamp. */
  sinceTimestamp?: number;
  /** Filter to a specific turn index. */
  turnIndex?: number;
  /** Limit the number of entries returned. */
  limit?: number;
}

export interface TranscriptRef {
  /** Run identifier. */
  runId: string;
  /** Store mode. */
  mode: TranscriptStoreMode;
  /** Number of transcript entries available for the run. */
  entryCount: number;
  /** Optional persisted path for file-backed stores. */
  path?: string;
  /** Timestamp of the latest entry when available. */
  lastUpdatedAt?: number;
}

export interface TranscriptStore {
  /** Storage mode for bootstrap/debug reporting. */
  readonly mode: TranscriptStoreMode;
  /** Append a transcript entry. */
  append(entry: TranscriptEntry): Promise<void>;
  /** Append multiple transcript entries. */
  appendMany(entries: TranscriptEntry[]): Promise<void>;
  /** Return all entries for a run. */
  list(runId: string): Promise<TranscriptEntry[]>;
  /** Replay transcript entries for a run with optional filtering. */
  replay(runId: string, options?: TranscriptReplayOptions): Promise<TranscriptEntry[]>;
  /** Compact the stored entries while preserving order. */
  compact(runId: string, keepLast?: number): Promise<void>;
  /** Replace the entries for a run, used for checkpoint restore. */
  replace(runId: string, entries: TranscriptEntry[]): Promise<void>;
  /** Clear transcript entries. */
  clear(runId?: string): Promise<void>;
  /** Resolve a stable reference to the run transcript. */
  getRef(runId: string): Promise<TranscriptRef>;
}
