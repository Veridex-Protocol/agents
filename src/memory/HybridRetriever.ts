/**
 * @packageDocumentation
 * @module HybridRetriever
 * @description
 * Hybrid memory retrieval that scores candidates with a weighted blend of
 * lexical, vector, temporal, and graph signals. Designed to sit on top of any
 * {@link MemoryStore} (plus an optional {@link SemanticMemoryGraph}) so that
 * callers can dial in the retrieval mode without rebuilding storage.
 */

import type { MemoryEntry, MemoryProvenance, MemoryQuery, MemoryStore } from '../types/memory';
import type { EmbedFn } from './MemoryLifecycle';
import type { SemanticMemoryGraph } from './SemanticMemoryGraph';

/** Individual retrieval signal contributing to the blended score. */
export type RetrievalMode = 'lexical' | 'vector' | 'temporal' | 'graph';

/** Options controlling how candidates are scored and combined. */
export interface HybridRetrievalOptions {
  /** Modes to combine. Defaults to ['lexical', 'temporal']. */
  modes?: RetrievalMode[];
  /** Per-mode weights. Missing weights default to 1 and are normalised. */
  weights?: Partial<Record<RetrievalMode, number>>;
  /** Maximum number of scored results to return. */
  limit?: number;
  /** Embed function for the query text when `vector` mode is enabled. */
  embed?: EmbedFn;
  /** Semantic graph required for `graph` mode. */
  graph?: SemanticMemoryGraph;
  /** Seed entry ids used as roots for graph expansion. */
  seedIds?: string[];
  /** Maximum graph hops from seeds. Defaults to 2. */
  graphMaxHops?: number;
  /** Half-life (ms) used by the temporal score. Defaults to 7 days. */
  halfLifeMs?: number;
  /** Reference timestamp for temporal scoring. Defaults to `Date.now()`. */
  now?: number;
  /**
   * Multiplier applied to the final score using entry confidence.
   * Defaults to true (score *= entry.confidence).
   */
  applyConfidence?: boolean;
  /**
   * Per-provenance multipliers applied after confidence. Missing sources
   * default to 1. Use values <1 to dampen low-trust sources or >1 to boost
   * curated ones. Final multiplier is clamped to [0, 2].
   */
  provenanceWeights?: Partial<Record<MemoryProvenance, number>>;
  /**
   * Penalty (0..1) applied to derived entries that lack any source
   * references. Defaults to 0 (no penalty).
   */
  unverifiedDerivationPenalty?: number;
}

/** A memory entry annotated with its blended score and per-mode breakdown. */
export interface ScoredMemory {
  entry: MemoryEntry;
  score: number;
  components: Partial<Record<RetrievalMode, number>>;
  /** Provenance multiplier applied (1 when no weighting was configured). */
  provenanceMultiplier: number;
  /** Confidence factor multiplied into the score (1 when disabled). */
  confidenceFactor: number;
}

const DEFAULT_MODES: RetrievalMode[] = ['lexical', 'temporal'];
const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_HOPS = 2;

export class HybridRetriever {
  constructor(private readonly store: MemoryStore) {}

  async retrieve(
    query: MemoryQuery & { text?: string },
    opts: HybridRetrievalOptions = {},
  ): Promise<ScoredMemory[]> {
    const modes = opts.modes && opts.modes.length > 0 ? opts.modes : DEFAULT_MODES;
    const weights = normaliseWeights(modes, opts.weights);
    const now = opts.now ?? Date.now();
    const halfLifeMs = opts.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
    const applyConfidence = opts.applyConfidence !== false;

    // Pull a broad candidate pool. We intentionally strip `text` and `limit`
    // so the store does not pre-filter — the retriever re-ranks across all
    // signals and truncates at the end.
    const { text: _droppedText, limit: _droppedLimit, ...poolQuery } = query;
    void _droppedText;
    void _droppedLimit;
    const candidatePool = await this.store.search(poolQuery);

    // Pre-compute helpers
    const queryText = (query.text ?? '').toLowerCase();
    const queryEmbedding =
      modes.includes('vector') && opts.embed && query.text
        ? await opts.embed(query.text)
        : undefined;
    const graphDistances =
      modes.includes('graph') && opts.graph && opts.seedIds && opts.seedIds.length > 0
        ? await computeGraphDistances(opts.graph, opts.seedIds, opts.graphMaxHops ?? DEFAULT_MAX_HOPS)
        : new Map<string, number>();

    const scored: ScoredMemory[] = candidatePool.map((entry) => {
      const components: Partial<Record<RetrievalMode, number>> = {};

      if (modes.includes('lexical')) {
        components.lexical = lexicalScore(queryText, entry.content);
      }
      if (modes.includes('vector')) {
        components.vector =
          queryEmbedding && entry.embedding ? cosine(queryEmbedding, entry.embedding) : 0;
      }
      if (modes.includes('temporal')) {
        const age = Math.max(0, now - entry.lastAccessedAt);
        components.temporal = Math.pow(0.5, age / halfLifeMs);
      }
      if (modes.includes('graph')) {
        const distance = graphDistances.get(entry.id);
        components.graph = distance === undefined ? 0 : 1 / (1 + distance);
      }

      let score = 0;
      for (const mode of modes) {
        score += (components[mode] ?? 0) * weights[mode];
      }

      const confidenceFactor = applyConfidence ? entry.confidence : 1;
      score *= confidenceFactor;

      let provenanceMultiplier = 1;
      if (opts.provenanceWeights) {
        const raw = opts.provenanceWeights[entry.provenance];
        if (typeof raw === 'number' && raw >= 0) {
          provenanceMultiplier = Math.min(2, raw);
        }
      }
      score *= provenanceMultiplier;

      const penalty = opts.unverifiedDerivationPenalty ?? 0;
      if (
        penalty > 0 &&
        entry.derivation &&
        (!entry.derivation.sourceEntryIds || entry.derivation.sourceEntryIds.length === 0) &&
        (!entry.derivation.sourceResourceIds || entry.derivation.sourceResourceIds.length === 0)
      ) {
        score *= Math.max(0, 1 - Math.min(1, penalty));
      }

      return { entry, score, components, provenanceMultiplier, confidenceFactor };
    });

    scored.sort((a, b) => b.score - a.score);
    const limit = opts.limit ?? query.limit ?? scored.length;
    return scored.slice(0, limit);
  }
}

// ── Helpers ──

function normaliseWeights(
  modes: RetrievalMode[],
  weights: Partial<Record<RetrievalMode, number>> | undefined,
): Record<RetrievalMode, number> {
  const raw: Record<RetrievalMode, number> = {
    lexical: 0,
    vector: 0,
    temporal: 0,
    graph: 0,
  };
  let sum = 0;
  for (const mode of modes) {
    const w = weights?.[mode];
    const value = typeof w === 'number' && w >= 0 ? w : 1;
    raw[mode] = value;
    sum += value;
  }
  if (sum === 0) {
    // Avoid divide-by-zero; fall back to uniform weights.
    const uniform = 1 / modes.length;
    for (const mode of modes) raw[mode] = uniform;
    return raw;
  }
  for (const mode of modes) raw[mode] /= sum;
  return raw;
}

function lexicalScore(query: string, content: string): number {
  if (!query) return 0;
  const qTokens = new Set(tokenise(query));
  if (qTokens.size === 0) return 0;
  const cTokens = new Set(tokenise(content.toLowerCase()));
  if (cTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of qTokens) {
    if (cTokens.has(token)) intersection += 1;
  }
  const union = qTokens.size + cTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenise(text: string): string[] {
  return text.split(/[^a-z0-9]+/i).filter((t) => t.length > 1);
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function computeGraphDistances(
  graph: SemanticMemoryGraph,
  seeds: string[],
  maxHops: number,
): Promise<Map<string, number>> {
  const distances = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [];
  for (const seed of seeds) {
    distances.set(seed, 0);
    queue.push({ id: seed, depth: 0 });
  }
  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number };
    if (depth >= maxHops) continue;
    const neighbourIds = await graph.neighbors(id);
    for (const next of neighbourIds) {
      if (distances.has(next)) continue;
      distances.set(next, depth + 1);
      queue.push({ id: next, depth: depth + 1 });
    }
  }
  return distances;
}
