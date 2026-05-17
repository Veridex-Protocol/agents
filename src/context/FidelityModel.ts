/**
 * @packageDocumentation
 * @module FidelityModel
 * @description
 * Root-Theorem-of-Context-Engineering fidelity model.
 *
 * Models output fidelity `F` as a monotonically decreasing function of
 * effective prompt size `P` (in tokens):
 *
 *   F(P) = max(0, 1 − D · P / 100_000)
 *
 * where `D` is a model-specific degradation coefficient (the empirical
 * percentage of fidelity lost per 100k tokens). The framework uses this
 * model to:
 *
 *   1. Compute a fidelity gate `P_gate(F_target)` — the largest prompt
 *      size at which the model is still expected to meet `F_target`.
 *   2. Decide when to trigger homeostatic compaction (typically at
 *      ~50% of `P_gate` to stay clear of the compression paradox).
 *   3. Emit per-turn `context_fidelity` trace events for observability.
 *
 * The linear form is a pragmatic first-order approximation. Real models
 * exhibit a plateau-then-cliff curve; teams can plug in a custom
 * `FidelityModel` once they have empirical data for their stack.
 */

/**
 * Optional hint passed to {@link FidelityModel.fidelity} so models can
 * apply a discount for **warm** (re-injected) tokens vs **cold** (novel)
 * tokens. See `EncodingTracker` and the Root Theorem of Context
 * Engineering for background.
 */
export interface EncodingHint {
  /** Fraction of `promptTokens` that are warm, in [0, 1]. */
  warmFraction: number;
  /**
   * How much less warm tokens degrade fidelity than cold ones. `0` means
   * warm tokens are free; `1` means no discount. Implementations MAY
   * ignore or override this. Defaults to `0.4` in `LinearFidelityModel`.
   */
  warmDiscount?: number;
}

/**
 * A fidelity model maps prompt size to expected fidelity in [0, 1] and
 * provides the inverse gate function used to size the homeostatic
 * budget.
 */
export interface FidelityModel {
  /** Identifier for traces and config (e.g. `linear:claude-3.5-sonnet`). */
  readonly id: string;
  /**
   * Estimated fidelity ∈ [0, 1] for an effective prompt size `P`.
   * MUST be monotonically non-increasing in `P`. When `encoding` is
   * supplied, implementations MAY reduce the effective `P` based on the
   * warm/cold split.
   */
  fidelity(promptTokens: number, encoding?: EncodingHint): number;
  /**
   * Largest prompt size at which `fidelity(P) ≥ target`. Used as the
   * effective context window `V_e`. Implementations MUST satisfy
   * `fidelity(pGate(t)) ≈ t` for any reachable `t ∈ (0, 1]`.
   */
  pGate(target: number): number;
}

/**
 * Linear fidelity model: `F(P) = max(0, 1 − D · P / 100_000)`.
 *
 * `D` is the percentage of fidelity lost per 100k tokens, expressed in
 * the same [0, 1] scale as fidelity itself. `D = 0.40` means the model
 * loses 40 fidelity points per 100k tokens of prompt.
 */
export class LinearFidelityModel implements FidelityModel {
  readonly id: string;
  readonly degradation: number;

  /**
   * @param degradation Fidelity loss per 100k tokens, in [0, ∞). Typical
   *   values fall in [0.10, 0.80] for modern long-context models.
   * @param id Optional identifier; defaults to `linear:<D>`.
   */
  constructor(degradation: number, id?: string) {
    if (!Number.isFinite(degradation) || degradation < 0) {
      throw new Error(
        `LinearFidelityModel: degradation must be a non-negative finite number, got ${degradation}`,
      );
    }
    this.degradation = degradation;
    this.id = id ?? `linear:${degradation}`;
  }

  fidelity(promptTokens: number, encoding?: EncodingHint): number {
    if (!Number.isFinite(promptTokens) || promptTokens <= 0) return 1;
    const effectiveTokens = applyEncodingDiscount(promptTokens, encoding);
    const f = 1 - (this.degradation * effectiveTokens) / 100_000;
    if (f < 0) return 0;
    if (f > 1) return 1;
    return f;
  }

  pGate(target: number): number {
    if (!Number.isFinite(target) || target <= 0) return Infinity;
    if (target >= 1) return 0;
    if (this.degradation === 0) return Infinity;
    return ((1 - target) * 100_000) / this.degradation;
  }
}

/**
 * Default degradation coefficients per model family.
 *
 * These are conservative working estimates derived from public
 * long-context benchmarks (RULER, BABILong, "Lost in the Middle"). They
 * are intentionally pessimistic so the framework triggers compaction
 * before a degradation cliff. Override via `registerModelDegradation`.
 */
export const MODEL_DEGRADATION: Record<string, number> = {
  // OpenAI
  'gpt-4o': 0.45,
  'gpt-4o-mini': 0.55,
  'gpt-4.1': 0.30,
  'gpt-4.1-mini': 0.40,
  'gpt-5': 0.25,
  'gpt-5-mini': 0.35,
  o1: 0.30,
  'o1-mini': 0.40,
  o3: 0.25,
  'o3-mini': 0.35,
  // Anthropic
  'claude-3-haiku': 0.55,
  'claude-3-sonnet': 0.45,
  'claude-3-opus': 0.40,
  'claude-3.5-haiku': 0.45,
  'claude-3.5-sonnet': 0.35,
  'claude-3.7-sonnet': 0.30,
  'claude-sonnet-4': 0.25,
  'claude-opus-4': 0.20,
  // Generic fallback
  default: 0.40,
};

/**
 * Apply an {@link EncodingHint} to raw prompt tokens to derive the
 * **effective** prompt tokens charged against fidelity.
 *
 *   P_eff = P · (1 − warmFraction · (1 − warmDiscount))
 *
 * `warmDiscount` defaults to `0.4` — warm tokens count for 40% of a cold
 * token. The function clamps inputs to safe ranges; invalid encoding
 * hints simply return `promptTokens`.
 */
export function applyEncodingDiscount(
  promptTokens: number,
  encoding?: EncodingHint,
): number {
  if (!encoding) return promptTokens;
  const wf = encoding.warmFraction;
  if (!Number.isFinite(wf) || wf <= 0) return promptTokens;
  const clampedWf = wf > 1 ? 1 : wf;
  const rawDiscount = encoding.warmDiscount ?? 0.4;
  const wd = !Number.isFinite(rawDiscount)
    ? 0.4
    : rawDiscount < 0
      ? 0
      : rawDiscount > 1
        ? 1
        : rawDiscount;
  const factor = 1 - clampedWf * (1 - wd);
  return promptTokens * factor;
}

/** Register or override a model's degradation coefficient at runtime. */
export function registerModelDegradation(model: string, degradation: number): void {
  if (!Number.isFinite(degradation) || degradation < 0) {
    throw new Error(`registerModelDegradation: invalid degradation ${degradation}`);
  }
  MODEL_DEGRADATION[model] = degradation;
}

/**
 * Look up the degradation coefficient for a model identifier. Performs
 * a prefix match so version-suffixed names (e.g. `gpt-4o-2024-11-20`)
 * resolve to their family entry. Returns the `default` value when no
 * match is found.
 */
export function degradationFor(model?: string): number {
  if (!model) return MODEL_DEGRADATION.default;
  if (MODEL_DEGRADATION[model] !== undefined) return MODEL_DEGRADATION[model];
  // Longest-prefix match across known keys.
  let best: string | undefined;
  for (const key of Object.keys(MODEL_DEGRADATION)) {
    if (key === 'default') continue;
    if (model.startsWith(key) && (!best || key.length > best.length)) {
      best = key;
    }
  }
  return best ? MODEL_DEGRADATION[best] : MODEL_DEGRADATION.default;
}

/**
 * Resolve a `FidelityModel` for the given inputs. Precedence:
 *   1. An explicit `model` instance.
 *   2. A `LinearFidelityModel` built from `degradation`.
 *   3. A `LinearFidelityModel` built from `degradationFor(modelId)`.
 */
export function resolveFidelityModel(input?: {
  model?: FidelityModel;
  degradation?: number;
  modelId?: string;
}): FidelityModel {
  if (input?.model) return input.model;
  if (typeof input?.degradation === 'number') {
    return new LinearFidelityModel(input.degradation, input.modelId);
  }
  const d = degradationFor(input?.modelId);
  return new LinearFidelityModel(d, input?.modelId ? `linear:${input.modelId}` : undefined);
}
