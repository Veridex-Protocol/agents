/**
 * MemoryLifecycle — Phase 3.2
 *
 * Background-style operations that keep a `MemoryStore` healthy over long
 * sessions: dedupe, promote, decay, and reconcile. The runner is pure logic
 * — it neither schedules itself nor mutates external state outside the
 * configured store and (optionally) the configured `SemanticMemoryGraph`.
 *
 * Strategy notes:
 *  - Dedupe: exact-content match first (cheap), then optional embedding
 *    cosine similarity ≥ τ via a caller-supplied `embed()` function. Keeps
 *    the higher-confidence entry; merges tags into the survivor.
 *  - Promote: episodic → semantic when confidence ≥ θ and the entry has
 *    survived at least `minAgeMs`. Records a `derivedFrom` edge if a
 *    graph is provided.
 *  - Decay: exponential confidence decay using `halfLifeMs`. Entries that
 *    fall below `floor` are deleted (and their graph edges removed).
 *  - Reconcile: scans the graph for `contradicts` edges and reports
 *    conflict pairs for the caller to handle (e.g., emit an event or
 *    suspend for approval).
 */

import type {
  MemoryEntry,
  MemoryStore,
  MemoryTier,
} from '../types/memory';
import type {
  MemoryEdge,
  SemanticMemoryGraph,
} from './SemanticMemoryGraph';
import type { AbsorptionGate, AbsorptionDecision } from './AbsorptionGate';

/** Extension of MemoryStore that supports in-place updates. */
export interface MutableMemoryStore extends MemoryStore {
  update(
    id: string,
    patch: Partial<
      Pick<
        MemoryEntry,
        'tier' | 'confidence' | 'tags' | 'metadata' | 'derivation' | 'ttlMs' | 'content'
      >
    >,
  ): Promise<MemoryEntry | null>;
}

/** Optional embedding hook (e.g., wired to an embeddings provider). */
export type EmbedFn = (text: string) => Promise<number[]> | number[];

export interface DedupeOptions {
  /** Cosine similarity threshold for embedding-based dedupe (0..1). */
  similarityThreshold?: number;
  /** Limit dedupe to a single tier (default: all). */
  tier?: MemoryTier;
}

export interface PromoteOptions {
  /** Minimum confidence to promote episodic → semantic. */
  minConfidence?: number;
  /** Minimum entry age in ms before promotion is considered. */
  minAgeMs?: number;
  /**
   * Optional absorption gate. Every candidate is judged before being
   * promoted; only `'allow'` verdicts proceed. `'escalate'` is treated
   * as `'deny'` UNLESS the gate itself routes the decision through an
   * approval/escalation handler (composite gates can do this).
   */
  gate?: AbsorptionGate;
  /**
   * Callback invoked with every decision (allow, deny, escalate)
   * regardless of outcome. Useful for audit logging.
   */
  onDecision?: (decision: AbsorptionDecision) => void;
  /**
   * Confidence multiplier applied to denied candidates so they do not
   * immediately re-trigger promotion next cycle. Defaults to `0.95`.
   * Set to `1` to disable.
   */
  denyConfidenceDecay?: number;
}

export interface DecayOptions {
  /** Half-life in ms — confidence is multiplied by 0.5 every halfLifeMs. */
  halfLifeMs?: number;
  /** Entries with confidence < floor after decay are deleted. */
  floor?: number;
}

export interface MemoryLifecycleOptions {
  store: MutableMemoryStore;
  graph?: SemanticMemoryGraph;
  embed?: EmbedFn;
  dedupe?: DedupeOptions;
  promote?: PromoteOptions;
  decay?: DecayOptions;
}

export interface DedupeResult {
  removed: number;
  merged: number;
}
export interface PromoteResult {
  /** Number of entries actually promoted to `semantic`. */
  promoted: number;
  /** Number of entries the gate denied. */
  denied: number;
  /** Number of entries the gate escalated (and were therefore deferred). */
  escalated: number;
  /** Full per-candidate decision log when a gate is configured. */
  decisions: AbsorptionDecision[];
}
export interface DecayResult {
  decayed: number;
  removed: number;
}
export interface ReconcileResult {
  conflicts: Array<{ a: string; b: string; edgeId: string }>;
}
export interface LifecycleReport {
  dedupe: DedupeResult;
  promote: PromoteResult;
  decay: DecayResult;
  reconcile: ReconcileResult;
}

const DEFAULT_SIMILARITY = 0.92;
const DEFAULT_MIN_CONFIDENCE = 0.75;
const DEFAULT_MIN_AGE_MS = 60_000; // 1 minute
const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_FLOOR = 0.05;

export class MemoryLifecycle {
  private readonly store: MutableMemoryStore;
  private readonly graph?: SemanticMemoryGraph;
  private readonly embed?: EmbedFn;
  private readonly dedupeOpts: Required<DedupeOptions> | { similarityThreshold: number; tier?: MemoryTier };
  private readonly promoteOpts: Required<Omit<PromoteOptions, 'gate' | 'onDecision'>> & {
    gate?: AbsorptionGate;
    onDecision?: (d: AbsorptionDecision) => void;
  };
  private readonly decayOpts: Required<DecayOptions>;

  constructor(opts: MemoryLifecycleOptions) {
    this.store = opts.store;
    this.graph = opts.graph;
    this.embed = opts.embed;
    this.dedupeOpts = {
      similarityThreshold: opts.dedupe?.similarityThreshold ?? DEFAULT_SIMILARITY,
      tier: opts.dedupe?.tier,
    };
    this.promoteOpts = {
      minConfidence: opts.promote?.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
      minAgeMs: opts.promote?.minAgeMs ?? DEFAULT_MIN_AGE_MS,
      denyConfidenceDecay: opts.promote?.denyConfidenceDecay ?? 0.95,
      gate: opts.promote?.gate,
      onDecision: opts.promote?.onDecision,
    };
    this.decayOpts = {
      halfLifeMs: opts.decay?.halfLifeMs ?? DEFAULT_HALF_LIFE_MS,
      floor: opts.decay?.floor ?? DEFAULT_FLOOR,
    };
  }

  /** Run every lifecycle operation in deterministic order. */
  async run(): Promise<LifecycleReport> {
    const dedupe = await this.dedupe();
    const promote = await this.promote();
    const decay = await this.decay();
    const reconcile = await this.reconcile();
    return { dedupe, promote, decay, reconcile };
  }

  async dedupe(): Promise<DedupeResult> {
    const entries = await this.store.search(
      this.dedupeOpts.tier ? { tier: this.dedupeOpts.tier, limit: 10_000 } : { limit: 10_000 },
    );
    if (entries.length < 2) return { removed: 0, merged: 0 };

    let removed = 0;
    let merged = 0;
    const alive = new Set<string>(entries.map((e) => e.id));

    // Pass 1 — exact content match within the same tier.
    const byKey = new Map<string, MemoryEntry[]>();
    for (const e of entries) {
      const key = `${e.tier}::${e.content}`;
      const list = byKey.get(key) ?? [];
      list.push(e);
      byKey.set(key, list);
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      const r = await this.collapseGroup(group);
      removed += r.removed;
      merged += r.merged;
      for (const id of r.removedIds) alive.delete(id);
    }

    // Pass 2 — embedding similarity (only if embedder provided).
    if (this.embed) {
      const livingEntries = entries.filter((e) => alive.has(e.id));
      const vectors = await Promise.all(
        livingEntries.map(async (e) => ({ id: e.id, v: await this.embed!(e.content) })),
      );
      for (let i = 0; i < livingEntries.length; i++) {
        if (!alive.has(livingEntries[i]!.id)) continue;
        for (let j = i + 1; j < livingEntries.length; j++) {
          if (!alive.has(livingEntries[j]!.id)) continue;
          const a = livingEntries[i]!;
          const b = livingEntries[j]!;
          if (a.tier !== b.tier) continue;
          const cs = cosine(vectors[i]!.v, vectors[j]!.v);
          if (cs >= this.dedupeOpts.similarityThreshold) {
            const r = await this.collapseGroup([a, b]);
            removed += r.removed;
            merged += r.merged;
            for (const id of r.removedIds) alive.delete(id);
          }
        }
      }
    }

    return { removed, merged };
  }

  async promote(): Promise<PromoteResult> {
    const now = Date.now();
    const candidates = await this.store.search({
      tier: 'episodic',
      minConfidence: this.promoteOpts.minConfidence,
      limit: 10_000,
    });
    const eligible = candidates.filter(
      (c) => now - c.createdAt >= this.promoteOpts.minAgeMs,
    );
    if (eligible.length === 0) {
      return { promoted: 0, denied: 0, escalated: 0, decisions: [] };
    }

    const gate = this.promoteOpts.gate;
    // No gate → legacy behaviour: every eligible candidate is promoted.
    if (!gate) {
      let promoted = 0;
      for (const c of eligible) {
        const updated = await this.store.update(c.id, { tier: 'semantic' });
        if (updated) promoted += 1;
      }
      return { promoted, denied: 0, escalated: 0, decisions: [] };
    }

    const decisions = await gate.evaluate(
      eligible.map((entry) => ({ entry, targetTier: 'semantic' as const })),
    );
    if (decisions.length !== eligible.length) {
      throw new Error(
        `AbsorptionGate '${gate.id}' returned ${decisions.length} decisions for ` +
          `${eligible.length} candidates`,
      );
    }

    let promoted = 0;
    let denied = 0;
    let escalated = 0;
    const decay = this.promoteOpts.denyConfidenceDecay;
    for (let i = 0; i < eligible.length; i++) {
      const candidate = eligible[i]!;
      const decision = decisions[i]!;
      this.promoteOpts.onDecision?.(decision);
      if (decision.verdict === 'allow') {
        const updated = await this.store.update(candidate.id, { tier: 'semantic' });
        if (updated) promoted += 1;
      } else if (decision.verdict === 'deny') {
        denied += 1;
        if (decay !== 1) {
          await this.store.update(candidate.id, {
            confidence: Math.max(0, candidate.confidence * decay),
          });
        }
      } else {
        // 'escalate' — candidate is left in episodic; caller is expected to
        // resolve via the gate's escalation path before the next cycle.
        escalated += 1;
      }
    }
    return { promoted, denied, escalated, decisions };
  }

  async decay(now: number = Date.now()): Promise<DecayResult> {
    const entries = await this.store.search({ limit: 10_000 });
    let decayed = 0;
    let removed = 0;
    const half = this.decayOpts.halfLifeMs;
    for (const e of entries) {
      // Procedural memory does not decay — it represents stable skills.
      if (e.tier === 'procedural') continue;
      const ageMs = now - e.lastAccessedAt;
      if (ageMs <= 0) continue;
      const factor = Math.pow(0.5, ageMs / half);
      const next = Math.max(0, e.confidence * factor);
      if (next < this.decayOpts.floor) {
        if (this.graph) await this.graph.removeNode(e.id);
        await this.store.delete(e.id);
        removed += 1;
      } else if (next < e.confidence - 1e-6) {
        await this.store.update(e.id, { confidence: next });
        decayed += 1;
      }
    }
    return { decayed, removed };
  }

  async reconcile(): Promise<ReconcileResult> {
    if (!this.graph) return { conflicts: [] };
    const contradictions = await this.graph.query({ kinds: ['contradicts'] });
    const conflicts = contradictions.map((e: MemoryEdge) => ({
      a: e.fromId,
      b: e.toId,
      edgeId: e.id,
    }));
    return { conflicts };
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async collapseGroup(
    group: MemoryEntry[],
  ): Promise<{ removed: number; merged: number; removedIds: string[] }> {
    // Keep the highest-confidence entry; merge tags into it; delete the rest.
    const sorted = [...group].sort((a, b) => b.confidence - a.confidence);
    const survivor = sorted[0]!;
    const losers = sorted.slice(1);
    const mergedTags = Array.from(
      new Set<string>([survivor.tags, ...losers.map((l) => l.tags)].flat()),
    );
    await this.store.update(survivor.id, {
      tags: mergedTags,
      // Confidence increases slightly per merge, capped at 1.
      confidence: Math.min(1, survivor.confidence + 0.05 * losers.length),
    });
    const removedIds: string[] = [];
    for (const l of losers) {
      if (this.graph) await this.graph.removeNode(l.id);
      await this.store.delete(l.id);
      removedIds.push(l.id);
    }
    return { removed: losers.length, merged: 1, removedIds };
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
