/**
 * @packageDocumentation
 * @module MemoryTypes
 * @description
 * Memory tier types and store interfaces for the Veridex Agent Fabric.
 *
 * The framework supports four memory classes: working, episodic,
 * semantic, and procedural. Memory writes carry provenance,
 * confidence, TTL, and scope metadata.
 */

// ── Memory Tiers ──

/** The four memory tier classes. */
export type MemoryTier = 'working' | 'episodic' | 'semantic' | 'procedural';

// ── Memory Entry ──

/** A single memory entry with metadata. */
export interface MemoryEntry {
  /** Unique entry identifier */
  id: string;
  /** Memory tier this entry belongs to */
  tier: MemoryTier;
  /** The memory content */
  content: string;
  /** Source of this memory (tool, model, user, system) */
  provenance: MemoryProvenance;
  /** When this memory was created */
  createdAt: number;
  /** When this memory was last accessed */
  lastAccessedAt: number;
  /** Confidence score (0-1) */
  confidence: number;
  /** Scope (run, agent, global) */
  scope: MemoryScope;
  /** Time-to-live in milliseconds (0 = no expiry) */
  ttlMs: number;
  /** Arbitrary tags for retrieval */
  tags: string[];
  /** Embedding vector (for semantic search, optional) */
  embedding?: number[];
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Source of a memory entry. */
export type MemoryProvenance = 'tool' | 'model' | 'user' | 'system' | 'import';

/** Scope of a memory entry. */
export type MemoryScope = 'turn' | 'run' | 'agent' | 'global';

// ── Memory Write Policy ──

/** Policy governing a memory write request. */
export interface MemoryWriteRequest {
  /** The entry to write */
  entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt'>;
  /** Overwrite strategy if an entry with the same content exists */
  overwriteStrategy: 'replace' | 'merge' | 'skip' | 'append';
  /** Source run ID */
  runId?: string;
  /** Source turn index */
  turnIndex?: number;
}

// ── Memory Query ──

/** Query parameters for memory retrieval. */
export interface MemoryQuery {
  /** Filter by tier */
  tier?: MemoryTier;
  /** Filter by scope */
  scope?: MemoryScope;
  /** Filter by tags (any match) */
  tags?: string[];
  /** Text search query */
  text?: string;
  /** Maximum number of results */
  limit?: number;
  /** Minimum confidence threshold */
  minConfidence?: number;
  /** Only entries newer than this timestamp */
  newerThan?: number;
}

// ── Memory Store Interface ──

/** Interface for memory storage backends. */
export interface MemoryStore {
  /** Read a single entry by ID. */
  read(id: string): Promise<MemoryEntry | null>;
  /** Write a memory entry. Returns the entry with generated ID and timestamps. */
  write(request: MemoryWriteRequest): Promise<MemoryEntry>;
  /** Search memory entries. */
  search(query: MemoryQuery): Promise<MemoryEntry[]>;
  /** Delete a single entry by ID. */
  delete(id: string): Promise<boolean>;
  /** Compact memory (remove expired, merge duplicates, archive old). */
  compact(options?: CompactOptions): Promise<CompactResult>;
  /** Clear all entries (optionally scoped). */
  clear(scope?: MemoryScope): Promise<void>;
}

/** Options for memory compaction. */
export interface CompactOptions {
  /** Remove entries older than this timestamp */
  olderThan?: number;
  /** Remove entries below this confidence */
  belowConfidence?: number;
  /** Maximum entries to keep per tier */
  maxPerTier?: number;
}

/** Result of a compaction operation. */
export interface CompactResult {
  /** Number of entries removed */
  removed: number;
  /** Number of entries merged */
  merged: number;
  /** Number of entries archived */
  archived: number;
}

// ── Memory Config ──

/** Configuration for the memory system. */
export interface MemoryConfig {
  /** Enable working memory (default: true) */
  working?: boolean;
  /** Episodic memory configuration */
  episodic?: TierConfig;
  /** Semantic memory configuration */
  semantic?: TierConfig;
  /** Procedural memory configuration */
  procedural?: TierConfig;
  /** Custom memory store backend */
  store?: MemoryStore;
}

/** Configuration for a specific memory tier. */
export interface TierConfig {
  /** Whether this tier is enabled */
  enabled?: boolean;
  /** Backend type hint */
  backend?: string;
  /** Freshness window in days */
  freshnessWindowDays?: number;
  /** Maximum entries for this tier */
  maxEntries?: number;
  /** Auto-compact interval in milliseconds */
  compactIntervalMs?: number;
}
