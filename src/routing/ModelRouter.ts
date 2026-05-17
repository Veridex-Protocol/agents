/**
 * @packageDocumentation
 * @module ModelRouter
 * @description
 * Task-aware model routing — Phase 5 item #4.
 *
 * Why this exists:
 *   A single agent uses many models. A planner wants slow, accurate
 *   reasoning. An extractor wants cheap, deterministic JSON. A
 *   classifier wants tiny latency. A judge wants a different vendor
 *   than the actor (to avoid self-evaluation bias). Hard-coding the
 *   model in every tool/prompt is fragile and makes A/B routing
 *   impossible.
 *
 * Design:
 *   - Caller registers candidate models with declared {@link ModelHints}
 *     (cost, latency, context window, quality tier, vendor, capability
 *     bits, and arbitrary tags).
 *   - Caller asks {@link ModelRouter.route} for a model by
 *     {@link TaskKind} (or `'custom'` with explicit constraints).
 *   - A {@link RoutingStrategy} scores each candidate; the highest
 *     score wins. Ties broken by registration order (deterministic).
 *   - Three built-in strategies: cost-optimised, latency-optimised,
 *     quality-optimised, plus a configurable weighted strategy.
 *   - The router is pure data — no I/O — so it's trivially testable
 *     and swappable.
 */

// ── Types ───────────────────────────────────────────────────────────────

/**
 * Coarse task kinds the runtime cares about. Custom kinds are
 * accepted via `customKind` on {@link RouteRequest}.
 */
export type TaskKind =
  | 'planner'
  | 'extractor'
  | 'classifier'
  | 'generator'
  | 'embedder'
  | 'judge'
  | 'summariser'
  | 'router'
  | 'custom';

/** Declarative hints a model advertises to the router. */
export interface ModelHints {
  /** USD per 1k input tokens. */
  inputCostPer1kUSD: number;
  /** USD per 1k output tokens. */
  outputCostPer1kUSD: number;
  /** Median latency for a short prompt, ms. */
  latencyMs: number;
  /** Maximum prompt + completion tokens the provider accepts. */
  contextTokens: number;
  /** Quality tier on a 0..1 scale, framework-relative. */
  quality: number;
  /** Vendor identifier (`openai`, `anthropic`, `local`, ...). */
  vendor: string;
  /** Capability flags. Defaults are all `false`. */
  capabilities?: ModelCapabilities;
  /** Free-form tags for matching (`'fast'`, `'cheap'`, `'reasoning'`). */
  tags?: readonly string[];
}

export interface ModelCapabilities {
  /** Native JSON-mode / structured outputs. */
  json?: boolean;
  /** Function/tool calling. */
  tools?: boolean;
  /** Vision. */
  vision?: boolean;
  /** Streaming. */
  streaming?: boolean;
  /** Extended-context (>200k tokens). */
  longContext?: boolean;
  /** Embeddings (instead of completions). */
  embeddings?: boolean;
}

/** A candidate registered with the router. */
export interface RoutableModel {
  /** Provider name as registered in {@link ModelRegistry}. */
  providerId: string;
  /** Model name passed in completion options (e.g. `'gpt-5-mini'`). */
  modelId: string;
  /** Declarative hints. */
  hints: ModelHints;
  /** Task kinds this model is willing to serve. */
  taskKinds: readonly TaskKind[];
  /** Optional human-readable label. */
  label?: string;
}

/** Constraints supplied at route-time. */
export interface RoutingConstraints {
  /** Hard cap on USD per 1k input tokens. */
  maxInputCostPer1kUSD?: number;
  /** Hard cap on latency ms. */
  maxLatencyMs?: number;
  /** Minimum quality tier (0..1). */
  minQuality?: number;
  /** Required capability flags (all must be set). */
  requiredCapabilities?: ReadonlyArray<keyof ModelCapabilities>;
  /** Required tags (all must be present). */
  requiredTags?: readonly string[];
  /** Required vendor (exact match). */
  vendor?: string;
  /** Disallow these vendors (e.g. for judge-vs-actor separation). */
  excludeVendors?: readonly string[];
  /** Minimum context window. */
  minContextTokens?: number;
}

/** A route request. */
export interface RouteRequest {
  /** Coarse task kind. Use `'custom'` for free-form routing. */
  taskKind: TaskKind;
  /** When `taskKind === 'custom'`, identifies the custom kind. */
  customKind?: string;
  /** Hard / soft constraints. */
  constraints?: RoutingConstraints;
  /** Approximate expected input tokens (used by cost-optimised strategy). */
  expectedInputTokens?: number;
  /** Approximate expected output tokens. */
  expectedOutputTokens?: number;
  /** Strategy override (defaults to the router's default). */
  strategy?: RoutingStrategy;
}

/** A routing decision. */
export interface RouteDecision {
  /** The selected model. */
  model: RoutableModel;
  /** Score the winning model achieved. */
  score: number;
  /** Candidates considered (in scoring order), for observability. */
  candidates: Array<{ model: RoutableModel; score: number; rejected?: string }>;
  /** Strategy used. */
  strategyId: string;
}

/**
 * A routing strategy. Scores each candidate; the highest score wins.
 * Negative scores indicate a hard rejection (the candidate is dropped).
 */
export interface RoutingStrategy {
  readonly id: string;
  score(model: RoutableModel, request: RouteRequest): number;
}

// ── Built-in strategies ────────────────────────────────────────────────

/**
 * Cost-optimised: minimise expected USD for the prompt; quality
 * acts as a tiebreaker so we don't pick obviously bad models.
 */
export const costOptimisedStrategy: RoutingStrategy = {
  id: 'cost-optimised',
  score(model, req) {
    const inTok = req.expectedInputTokens ?? 1000;
    const outTok = req.expectedOutputTokens ?? 250;
    const usd =
      (inTok / 1000) * model.hints.inputCostPer1kUSD +
      (outTok / 1000) * model.hints.outputCostPer1kUSD;
    // Score is inverse cost; add tiny quality bias to break ties.
    return 1 / (usd + 1e-6) + model.hints.quality * 1e-3;
  },
};

/** Latency-optimised: minimise median latency. */
export const latencyOptimisedStrategy: RoutingStrategy = {
  id: 'latency-optimised',
  score(model) {
    return 1 / (model.hints.latencyMs + 1) + model.hints.quality * 1e-3;
  },
};

/** Quality-optimised: maximise quality tier. */
export const qualityOptimisedStrategy: RoutingStrategy = {
  id: 'quality-optimised',
  score(model) {
    return model.hints.quality;
  },
};

/**
 * Weighted blend of normalised cost / latency / quality. Weights sum
 * to 1 internally; pass any positive weights you like.
 */
export interface WeightedStrategyConfig {
  cost?: number;
  latency?: number;
  quality?: number;
  /** Cap normalisers — anything above this is treated as the cap. */
  maxLatencyMs?: number;
  maxCostPer1kUSD?: number;
}

export function weightedStrategy(config: WeightedStrategyConfig): RoutingStrategy {
  const wCost = Math.max(0, config.cost ?? 0);
  const wLat = Math.max(0, config.latency ?? 0);
  const wQual = Math.max(0, config.quality ?? 0);
  const sum = wCost + wLat + wQual || 1;
  const ncost = wCost / sum;
  const nlat = wLat / sum;
  const nqual = wQual / sum;
  const latCap = config.maxLatencyMs ?? 10_000;
  const costCap = config.maxCostPer1kUSD ?? 50;
  return {
    id: `weighted(${ncost.toFixed(2)}/${nlat.toFixed(2)}/${nqual.toFixed(2)})`,
    score(model, req) {
      const inTok = req.expectedInputTokens ?? 1000;
      const outTok = req.expectedOutputTokens ?? 250;
      const usd =
        (inTok / 1000) * model.hints.inputCostPer1kUSD +
        (outTok / 1000) * model.hints.outputCostPer1kUSD;
      const costNorm = 1 - Math.min(1, usd / costCap);
      const latNorm = 1 - Math.min(1, model.hints.latencyMs / latCap);
      const qualNorm = Math.max(0, Math.min(1, model.hints.quality));
      return ncost * costNorm + nlat * latNorm + nqual * qualNorm;
    },
  };
}

// ── Router ──────────────────────────────────────────────────────────────

export interface ModelRouterOptions {
  /** Default strategy when {@link RouteRequest.strategy} is omitted. */
  defaultStrategy?: RoutingStrategy;
}

export class ModelRouter {
  private readonly models: RoutableModel[] = [];
  private readonly defaultStrategy: RoutingStrategy;

  constructor(options: ModelRouterOptions = {}) {
    this.defaultStrategy = options.defaultStrategy ?? qualityOptimisedStrategy;
  }

  /** Register a candidate. Duplicate `(providerId, modelId)` pairs throw. */
  register(model: RoutableModel): void {
    if (this.find(model.providerId, model.modelId)) {
      throw new Error(
        `ModelRouter: duplicate model '${model.providerId}/${model.modelId}'`,
      );
    }
    this.models.push(model);
  }

  /** Register many at once. */
  registerMany(models: readonly RoutableModel[]): void {
    for (const m of models) this.register(m);
  }

  /** Unregister; returns true if a model was removed. */
  unregister(providerId: string, modelId: string): boolean {
    const i = this.models.findIndex(
      (m) => m.providerId === providerId && m.modelId === modelId,
    );
    if (i < 0) return false;
    this.models.splice(i, 1);
    return true;
  }

  /** Total registered models. */
  size(): number {
    return this.models.length;
  }

  /** List all candidates (defensive copy). */
  list(): RoutableModel[] {
    return [...this.models];
  }

  private find(providerId: string, modelId: string): RoutableModel | undefined {
    return this.models.find(
      (m) => m.providerId === providerId && m.modelId === modelId,
    );
  }

  /**
   * Pick the best model for a request. Throws when no candidate
   * survives the hard constraints; the caller is expected to either
   * relax constraints or register a fallback.
   */
  route(request: RouteRequest): RouteDecision {
    const strategy = request.strategy ?? this.defaultStrategy;
    const candidates: Array<{ model: RoutableModel; score: number; rejected?: string }> = [];

    for (const model of this.models) {
      // Task-kind eligibility.
      if (!model.taskKinds.includes(request.taskKind)) {
        candidates.push({ model, score: -Infinity, rejected: 'task_kind_mismatch' });
        continue;
      }

      const reject = this.checkConstraints(model, request.constraints);
      if (reject) {
        candidates.push({ model, score: -Infinity, rejected: reject });
        continue;
      }

      const score = strategy.score(model, request);
      if (!Number.isFinite(score) || score < 0) {
        candidates.push({ model, score, rejected: 'strategy_rejected' });
        continue;
      }
      candidates.push({ model, score });
    }

    const viable = candidates.filter((c) => c.rejected === undefined);
    if (viable.length === 0) {
      throw new Error(
        `ModelRouter: no candidate satisfies request (taskKind=${request.taskKind}). ` +
          `Considered ${candidates.length} model(s); rejections: ` +
          candidates
            .map((c) => `${c.model.providerId}/${c.model.modelId}=${c.rejected}`)
            .join(', '),
      );
    }

    // Stable sort: by score desc, registration order ascending.
    viable.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return this.models.indexOf(a.model) - this.models.indexOf(b.model);
    });

    return {
      model: viable[0].model,
      score: viable[0].score,
      candidates: viable,
      strategyId: strategy.id,
    };
  }

  private checkConstraints(
    model: RoutableModel,
    c: RoutingConstraints | undefined,
  ): string | null {
    if (!c) return null;
    if (
      c.maxInputCostPer1kUSD !== undefined &&
      model.hints.inputCostPer1kUSD > c.maxInputCostPer1kUSD
    ) {
      return 'cost_cap_exceeded';
    }
    if (c.maxLatencyMs !== undefined && model.hints.latencyMs > c.maxLatencyMs) {
      return 'latency_cap_exceeded';
    }
    if (c.minQuality !== undefined && model.hints.quality < c.minQuality) {
      return 'quality_below_floor';
    }
    if (
      c.minContextTokens !== undefined &&
      model.hints.contextTokens < c.minContextTokens
    ) {
      return 'context_window_too_small';
    }
    if (c.vendor !== undefined && model.hints.vendor !== c.vendor) {
      return 'vendor_mismatch';
    }
    if (c.excludeVendors && c.excludeVendors.includes(model.hints.vendor)) {
      return 'vendor_excluded';
    }
    if (c.requiredCapabilities) {
      const caps = model.hints.capabilities ?? {};
      for (const cap of c.requiredCapabilities) {
        if (!caps[cap]) return `missing_capability:${cap}`;
      }
    }
    if (c.requiredTags) {
      const tags = new Set(model.hints.tags ?? []);
      for (const t of c.requiredTags) {
        if (!tags.has(t)) return `missing_tag:${t}`;
      }
    }
    return null;
  }
}
