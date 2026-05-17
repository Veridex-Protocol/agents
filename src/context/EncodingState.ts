/**
 * @packageDocumentation
 * @module EncodingState
 * @description
 * Per-thread **shared encoding state** for the Root Theorem context engine.
 *
 * The Root Theorem of Context Engineering distinguishes two kinds of
 * prompt content:
 *
 * - **Warm injection** — content the model has already encoded in a prior
 *   turn of the same thread. Decoder caches make it cheaper, and (more
 *   importantly) the model has already "spent" attention budget on it; its
 *   effective contribution to degradation is reduced.
 * - **Cold injection** — novel content the model has never seen. Pays the
 *   full degradation cost.
 *
 * `EncodingTracker` maintains the set of chunks (typically paragraphs)
 * that have been injected into a given thread. After each compile we
 * (1) **classify** the new prompt into warm and cold token counts, then
 * (2) **record** the prompt so its chunks become warm for the next turn.
 *
 * The tracker is intentionally pure (no I/O). Persistence is provided by
 * `serialize()` / `deserialize()` which encode/decode a single
 * `MemoryEntry` of kind `'encoding'`.
 *
 * The default chunking strategy splits on blank lines (paragraphs) and
 * normalises whitespace before hashing so cosmetically-different
 * reinjections still match. Implementations may override chunking by
 * subclassing or passing a `chunker` option.
 */

import { createHash } from 'node:crypto';

/** A single chunk known to the tracker. */
export interface EncodingChunk {
  /** Stable content hash. */
  hash: string;
  /** Estimated token count. */
  tokens: number;
  /** Last time this chunk was seen in a prompt. */
  lastSeenAt: number;
  /** Number of times this chunk has been recorded. */
  hits: number;
}

/** Read-only snapshot of tracker state. */
export interface EncodingState {
  /** Thread identifier (typically `runId`). */
  threadId: string;
  /** Total number of distinct chunks known. */
  size: number;
  /** Sum of `tokens` across all known chunks (rough working-set size). */
  totalTokens: number;
  /** Tokens classified as warm in the most recent `classify()` call. */
  lastWarmTokens: number;
  /** Tokens classified as cold in the most recent `classify()` call. */
  lastColdTokens: number;
}

/** Result of `EncodingTracker.classify`. */
export interface EncodingClassification {
  /** Token count classified as warm (chunks previously recorded). */
  warmTokens: number;
  /** Token count classified as cold (novel chunks). */
  coldTokens: number;
  /** Fraction of total prompt tokens that are warm, in [0, 1]. */
  warmFraction: number;
  /** Per-chunk classification entries, in document order. */
  chunks: Array<{ hash: string; tokens: number; warm: boolean }>;
}

/** Options for `EncodingTracker.classify` / `EncodingTracker.record`. */
export interface ClassifyOptions {
  /** Pre-computed token count for the whole content (skips estimator). */
  tokens?: number;
  /** Override per-chunk tokens (must match the chunked length when set). */
  chunkTokens?: number[];
}

export interface RecordOptions extends ClassifyOptions {
  /** Override the `lastSeenAt` clock — useful for deterministic tests. */
  at?: number;
}

/** Public contract for encoding-state trackers. */
export interface EncodingTracker {
  /** Stable thread identifier this tracker is bound to. */
  readonly threadId: string;
  /**
   * Classify content into warm/cold without mutating tracker state.
   * Use this BEFORE injecting content into a prompt to decide fidelity.
   */
  classify(content: string, opts?: ClassifyOptions): EncodingClassification;
  /**
   * Record content as having been injected. Each chunk becomes warm for
   * subsequent classifications. Returns the classification at record time.
   */
  record(content: string, opts?: RecordOptions): EncodingClassification;
  /** Snapshot of state for serialization / telemetry. */
  snapshot(): EncodingState;
  /** Drop all chunks (e.g., when starting a new thread). */
  reset(): void;
  /** Serialize state to a JSON-safe payload. */
  serialize(): SerializedEncodingState;
  /** Restore state from a previously serialized payload. */
  deserialize(payload: SerializedEncodingState): void;
}

/** JSON-safe encoding-state payload. */
export interface SerializedEncodingState {
  version: 1;
  threadId: string;
  chunks: EncodingChunk[];
}

/** Options for `LRUEncodingTracker`. */
export interface LRUEncodingTrackerOptions {
  /** Thread identifier (typically `runId`). */
  threadId: string;
  /**
   * Maximum number of distinct chunks to retain. Older (least-recently-
   * seen) chunks are evicted when the cap is exceeded. Defaults to 4096
   * — enough to cover ~hundreds of turns at realistic chunk sizes.
   */
  maxChunks?: number;
  /**
   * Chunker. Defaults to splitting on blank lines (paragraph boundaries)
   * and dropping empties. Override for domain-specific tokenisers.
   */
  chunker?: (content: string) => string[];
  /**
   * Token estimator. Defaults to `Math.ceil(text.length / 4)` to match
   * `ContextCompiler.estimateTokens`.
   */
  estimateTokens?: (text: string) => number;
}

const DEFAULT_MAX_CHUNKS = 4096;

/**
 * Default LRU-backed implementation of {@link EncodingTracker}.
 *
 * Chunks are stored in a plain Map keyed by content hash. Recency is
 * tracked via insertion order on each `record()` (delete + re-set), and
 * eviction trims the oldest entries when `size > maxChunks`.
 */
export class LRUEncodingTracker implements EncodingTracker {
  readonly threadId: string;
  private readonly maxChunks: number;
  private readonly chunker: (content: string) => string[];
  private readonly estimator: (text: string) => number;
  private chunks = new Map<string, EncodingChunk>();
  private lastWarmTokens = 0;
  private lastColdTokens = 0;

  constructor(options: LRUEncodingTrackerOptions) {
    if (!options.threadId) {
      throw new Error('LRUEncodingTracker: threadId is required');
    }
    this.threadId = options.threadId;
    this.maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
    this.chunker = options.chunker ?? defaultChunker;
    this.estimator = options.estimateTokens ?? defaultEstimator;
  }

  classify(content: string, opts?: ClassifyOptions): EncodingClassification {
    return this.classifyInternal(content, opts, /*mutate*/ false, Date.now());
  }

  record(content: string, opts?: RecordOptions): EncodingClassification {
    const now = opts?.at ?? Date.now();
    return this.classifyInternal(content, opts, /*mutate*/ true, now);
  }

  snapshot(): EncodingState {
    let totalTokens = 0;
    for (const c of this.chunks.values()) totalTokens += c.tokens;
    return {
      threadId: this.threadId,
      size: this.chunks.size,
      totalTokens,
      lastWarmTokens: this.lastWarmTokens,
      lastColdTokens: this.lastColdTokens,
    };
  }

  reset(): void {
    this.chunks.clear();
    this.lastWarmTokens = 0;
    this.lastColdTokens = 0;
  }

  serialize(): SerializedEncodingState {
    return {
      version: 1,
      threadId: this.threadId,
      chunks: [...this.chunks.values()],
    };
  }

  deserialize(payload: SerializedEncodingState): void {
    if (payload.version !== 1) {
      throw new Error(
        `LRUEncodingTracker.deserialize: unsupported version ${payload.version}`,
      );
    }
    this.chunks.clear();
    // Restore in declared order so eviction reflects original recency.
    for (const c of payload.chunks) {
      this.chunks.set(c.hash, { ...c });
    }
  }

  // ── internal ──

  private classifyInternal(
    content: string,
    opts: ClassifyOptions | undefined,
    mutate: boolean,
    now: number,
  ): EncodingClassification {
    const pieces = this.chunker(content).filter((p) => p.length > 0);
    if (pieces.length === 0) {
      const result: EncodingClassification = {
        warmTokens: 0,
        coldTokens: 0,
        warmFraction: 0,
        chunks: [],
      };
      if (mutate) {
        this.lastWarmTokens = 0;
        this.lastColdTokens = 0;
      }
      return result;
    }

    // Compute per-chunk tokens. If caller provided override, validate length.
    let perChunk: number[];
    if (opts?.chunkTokens) {
      if (opts.chunkTokens.length !== pieces.length) {
        throw new Error(
          `LRUEncodingTracker.classify: chunkTokens length (${opts.chunkTokens.length}) ` +
            `must match chunk count (${pieces.length})`,
        );
      }
      perChunk = opts.chunkTokens;
    } else if (typeof opts?.tokens === 'number') {
      // Distribute proportional to chunk length so the sum matches the
      // caller-supplied total exactly.
      const totalChars = pieces.reduce((sum, p) => sum + p.length, 0);
      if (totalChars === 0) {
        perChunk = pieces.map(() => 0);
      } else {
        let allocated = 0;
        perChunk = pieces.map((p, i) => {
          const isLast = i === pieces.length - 1;
          const share = isLast
            ? opts.tokens! - allocated
            : Math.round((opts.tokens! * p.length) / totalChars);
          allocated += share;
          return share;
        });
      }
    } else {
      perChunk = pieces.map((p) => this.estimator(p));
    }

    let warmTokens = 0;
    let coldTokens = 0;
    const chunks: EncodingClassification['chunks'] = [];
    for (let i = 0; i < pieces.length; i++) {
      const hash = hashChunk(pieces[i]!);
      const tokens = perChunk[i] ?? 0;
      const isWarm = this.chunks.has(hash);
      if (isWarm) {
        warmTokens += tokens;
      } else {
        coldTokens += tokens;
      }
      chunks.push({ hash, tokens, warm: isWarm });

      if (mutate) {
        const existing = this.chunks.get(hash);
        if (existing) {
          // Bump recency: delete + re-set moves to the end of insertion order.
          this.chunks.delete(hash);
          this.chunks.set(hash, {
            hash,
            tokens,
            lastSeenAt: now,
            hits: existing.hits + 1,
          });
        } else {
          this.chunks.set(hash, { hash, tokens, lastSeenAt: now, hits: 1 });
        }
      }
    }

    if (mutate) {
      this.evict();
      this.lastWarmTokens = warmTokens;
      this.lastColdTokens = coldTokens;
    }

    const total = warmTokens + coldTokens;
    const warmFraction = total === 0 ? 0 : warmTokens / total;
    return { warmTokens, coldTokens, warmFraction, chunks };
  }

  private evict(): void {
    while (this.chunks.size > this.maxChunks) {
      // Map iteration is insertion order; the first key is the oldest.
      const oldest = this.chunks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.chunks.delete(oldest);
    }
  }
}

// ── helpers ──

/** Default paragraph chunker: split on blank lines, trim, normalise whitespace. */
export function defaultChunker(content: string): string[] {
  if (!content) return [];
  return content
    .split(/\n\s*\n+/)
    .map((p) => normalize(p))
    .filter((p) => p.length > 0);
}

function defaultEstimator(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hashChunk(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}
