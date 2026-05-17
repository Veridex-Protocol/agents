/**
 * @packageDocumentation
 * @module HomeostaticContextEngine
 * @description
 * Fidelity-aware wrapper around {@link ContextCompiler}.
 *
 * Where the bare {@link ContextCompiler} only enforces a token budget,
 * the homeostatic engine treats context as a bounded lossy channel and
 * actively monitors expected output fidelity using a
 * {@link FidelityModel}. After compiling, it:
 *
 *   1. Evaluates `F(P)` for the produced prompt size.
 *   2. Computes the effective context window `P_gate(F_target)`.
 *   3. Fires a {@link CompactionTrigger} when either:
 *        a. `P ≥ compactionThreshold · P_gate` (default 0.5), or
 *        b. `F(P) < F_target` (already underwater).
 *      The trigger surfaces a structured reason so callers can route
 *      to summarisation, archival, or human review without re-deriving
 *      the math.
 *
 * The engine does NOT itself rewrite or shed content — that is the
 * Compactor's job (see Phase 2.3). This separation keeps fidelity
 * accounting deterministic and side-effect-free; compaction policy
 * stays pluggable.
 *
 * @example
 * ```ts
 * const engine = new HomeostaticContextEngine({
 *   modelId: 'claude-3.5-sonnet',
 *   fidelityTarget: 0.85,
 *   onCompactionRequired: (e) => console.warn('compact!', e.reason),
 * });
 * const plan = engine.compile({ maxTokens: 32_000, sections });
 * if (plan.compactionTriggered) {
 *   // hand off to a Compactor
 * }
 * ```
 */

import { ContextCompiler, DEFAULT_RETRIEVAL_POLICY } from './ContextCompiler';
import {
  resolveFidelityModel,
  type FidelityModel,
} from './FidelityModel';
import type { EncodingTracker } from './EncodingState';
import type {
  ContextCompilerOptions,
  ContextPlan,
  ContextRetrievalPolicy,
} from '../types/context';

/** Why the engine decided compaction is needed this turn. */
export type CompactionReason =
  /** Prompt size has reached `compactionThreshold · P_gate`. */
  | 'approaching_pgate'
  /** Estimated fidelity has already dropped below the target. */
  | 'fidelity_below_target'
  /** Compiler reported truncation — content is being lost. */
  | 'truncation_observed';

/** Telemetry/event emitted whenever fidelity is evaluated. */
export interface FidelityReport {
  /** Identifier of the fidelity model used. */
  modelId: string;
  /** Total prompt tokens reported by the compiler. */
  promptTokens: number;
  /**
   * Effective prompt tokens after applying the encoding discount
   * (warm tokens count less). Equals `promptTokens` when no
   * `EncodingTracker` is configured.
   */
  effectivePromptTokens: number;
  /** Tokens classified as warm (re-injected) this turn. */
  warmTokens: number;
  /** Tokens classified as cold (novel) this turn. */
  coldTokens: number;
  /** Fraction of `promptTokens` that were warm, in [0, 1]. */
  warmFraction: number;
  /** Estimated fidelity ∈ [0, 1] (computed against effective P). */
  fidelity: number;
  /** Target fidelity the caller is trying to hold. */
  fidelityTarget: number;
  /** Effective context window for the configured target. */
  pGate: number;
  /** Fraction `effectivePromptTokens / pGate` (clamped to ≥ 0). */
  pGateUsage: number;
  /** Whether compaction was triggered this turn. */
  compactionTriggered: boolean;
  /** Reasons the trigger fired (empty when no trigger). */
  reasons: CompactionReason[];
  /** Timestamp when the report was produced. */
  emittedAt: number;
}

/** Trigger payload handed to consumers when compaction is needed. */
export interface CompactionTrigger extends FidelityReport {
  /** Compiled plan that produced the report (read-only). */
  plan: HomeostaticContextPlan;
}

/** Extension of {@link ContextPlan} with fidelity bookkeeping. */
export interface HomeostaticContextPlan extends ContextPlan {
  /** Full fidelity report produced for this plan. */
  fidelityReport: FidelityReport;
  /** Convenience alias for `fidelityReport.compactionTriggered`. */
  compactionTriggered: boolean;
}

/** Construction options for {@link HomeostaticContextEngine}. */
export interface HomeostaticContextEngineOptions {
  /**
   * Fidelity model instance to use. Overrides `modelId`/`degradation`.
   */
  fidelityModel?: FidelityModel;
  /** Model identifier used to look up a default degradation coefficient. */
  modelId?: string;
  /** Explicit degradation coefficient (per 100k tokens). */
  degradation?: number;
  /**
   * Target fidelity to hold. Defaults to `0.85`. Must be in (0, 1).
   * `P_gate(target)` defines the effective context window the engine
   * tries to stay under.
   */
  fidelityTarget?: number;
  /**
   * Fraction of `P_gate` at which `approaching_pgate` triggers. Defaults
   * to `0.5` (the compression-paradox-safe trigger from the Root Theorem
   * paper). Must be in (0, 1].
   */
  compactionThreshold?: number;
  /**
   * Reuse a specific {@link ContextCompiler} instance. Defaults to a
   * fresh one.
   */
  compiler?: ContextCompiler;
  /**
   * Default retrieval policy used by `compileWithPolicy`. Defaults to
   * {@link DEFAULT_RETRIEVAL_POLICY}.
   */
  defaultPolicy?: ContextRetrievalPolicy;
  /**
   * Listener invoked on every compile, regardless of trigger state.
   * Useful for telemetry / event-bus wiring.
   */
  onFidelityReport?: (report: FidelityReport) => void;
  /**
   * Listener invoked only when compaction is required. Receives the
   * full {@link CompactionTrigger} including the plan.
   */
  onCompactionRequired?: (trigger: CompactionTrigger) => void;
  /**
   * Optional per-thread {@link EncodingTracker}. When supplied, the
   * engine classifies each compiled plan into warm/cold tokens and
   * applies a discount to the effective prompt size used for fidelity
   * calculations. After each compile, the tracker is updated so the
   * just-injected content becomes warm for the next turn.
   */
  encoding?: EncodingTracker;
  /**
   * Override the warm-token discount passed to the fidelity model.
   * `0` makes warm tokens free; `1` disables the discount. Defaults to
   * the fidelity model's own default (typically `0.4`).
   */
  warmDiscount?: number;
}

const DEFAULT_FIDELITY_TARGET = 0.85;
const DEFAULT_COMPACTION_THRESHOLD = 0.5;

export class HomeostaticContextEngine {
  readonly compiler: ContextCompiler;
  readonly fidelityModel: FidelityModel;
  readonly fidelityTarget: number;
  readonly compactionThreshold: number;
  readonly defaultPolicy: ContextRetrievalPolicy;
  readonly encoding?: EncodingTracker;
  readonly warmDiscount?: number;
  private readonly onFidelityReport?: (report: FidelityReport) => void;
  private readonly onCompactionRequired?: (trigger: CompactionTrigger) => void;

  constructor(options: HomeostaticContextEngineOptions = {}) {
    const target = options.fidelityTarget ?? DEFAULT_FIDELITY_TARGET;
    if (!Number.isFinite(target) || target <= 0 || target >= 1) {
      throw new Error(
        `HomeostaticContextEngine: fidelityTarget must be in (0, 1), got ${target}`,
      );
    }
    const threshold = options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new Error(
        `HomeostaticContextEngine: compactionThreshold must be in (0, 1], got ${threshold}`,
      );
    }
    this.compiler = options.compiler ?? new ContextCompiler();
    this.fidelityModel = resolveFidelityModel({
      model: options.fidelityModel,
      modelId: options.modelId,
      degradation: options.degradation,
    });
    this.fidelityTarget = target;
    this.compactionThreshold = threshold;
    this.defaultPolicy = options.defaultPolicy ?? DEFAULT_RETRIEVAL_POLICY;
    this.encoding = options.encoding;
    this.warmDiscount = options.warmDiscount;
    this.onFidelityReport = options.onFidelityReport;
    this.onCompactionRequired = options.onCompactionRequired;
  }

  /**
   * Compile context within budget AND evaluate fidelity. Equivalent to
   * `ContextCompiler.compile` but returns a {@link HomeostaticContextPlan}
   * and may fire `onCompactionRequired`.
   */
  compile(options: ContextCompilerOptions): HomeostaticContextPlan {
    const base = this.compiler.compile(options);
    return this.wrap(base, /*recordEncoding*/ true);
  }

  /** Policy-aware variant — see {@link ContextCompiler.compileWithPolicy}. */
  compileWithPolicy(
    options: ContextCompilerOptions,
    policy: ContextRetrievalPolicy = this.defaultPolicy,
  ): HomeostaticContextPlan {
    const base = this.compiler.compileWithPolicy(options, policy);
    return this.wrap(base);
  }

  /**
   * Evaluate fidelity for an already-compiled plan without re-running
   * the compiler. Useful when callers compile elsewhere but still want
   * the homeostatic accounting.
   */
  evaluate(plan: ContextPlan): FidelityReport {
    return this.report(plan);
  }

  // ── Internal ──

  private wrap(base: ContextPlan, recordEncoding = false): HomeostaticContextPlan {
    const reasons: CompactionReason[] = [];

    // Classify warm/cold via the encoding tracker, if any. We classify
    // (read-only) BEFORE computing fidelity, then record AFTER so the
    // chunks we just injected are warm next turn.
    let warmTokens = 0;
    let coldTokens = base.totalTokens;
    let warmFraction = 0;
    if (this.encoding && base.totalTokens > 0) {
      // Classify each section independently so the tracker's chunker can
      // split on paragraph boundaries while we still honour the
      // compiler's per-section `actualTokens` (which already reflects
      // truncation / compression).
      for (const sec of base.sections) {
        if (!sec.content || sec.actualTokens <= 0) continue;
        const c = this.encoding.classify(sec.content, { tokens: sec.actualTokens });
        warmTokens += c.warmTokens;
        coldTokens += c.coldTokens;
      }
      // Re-derive coldTokens from totals so it always matches
      // `base.totalTokens - warmTokens` (avoids drift from rounding).
      coldTokens = Math.max(0, base.totalTokens - warmTokens);
      warmFraction = base.totalTokens === 0 ? 0 : warmTokens / base.totalTokens;
    }

    const encodingHint =
      this.encoding && warmFraction > 0
        ? { warmFraction, warmDiscount: this.warmDiscount }
        : undefined;
    const f = this.fidelityModel.fidelity(base.totalTokens, encodingHint);
    const effectiveTokens = encodingHint
      ? base.totalTokens * (1 - encodingHint.warmFraction * (1 - (encodingHint.warmDiscount ?? 0.4)))
      : base.totalTokens;
    const gate = this.fidelityModel.pGate(this.fidelityTarget);
    const usage = gate > 0 && Number.isFinite(gate) ? effectiveTokens / gate : 0;

    if (Number.isFinite(gate) && effectiveTokens >= this.compactionThreshold * gate) {
      reasons.push('approaching_pgate');
    }
    if (f < this.fidelityTarget) {
      reasons.push('fidelity_below_target');
    }
    if (base.hadTruncation) {
      reasons.push('truncation_observed');
    }

    const fidelityReport: FidelityReport = {
      modelId: this.fidelityModel.id,
      promptTokens: base.totalTokens,
      effectivePromptTokens: effectiveTokens,
      warmTokens,
      coldTokens,
      warmFraction,
      fidelity: f,
      fidelityTarget: this.fidelityTarget,
      pGate: gate,
      pGateUsage: usage,
      compactionTriggered: reasons.length > 0,
      reasons,
      emittedAt: Date.now(),
    };

    const plan: HomeostaticContextPlan = {
      ...base,
      fidelityReport,
      compactionTriggered: fidelityReport.compactionTriggered,
    };

    this.onFidelityReport?.(fidelityReport);
    if (fidelityReport.compactionTriggered) {
      this.onCompactionRequired?.({ ...fidelityReport, plan });
    }

    // Commit the just-injected content into the encoding tracker so it
    // becomes warm for the next turn. We only record on a real compile
    // path (not on `evaluate`, which routes through `report`). To avoid
    // double-counting during nested calls, we record after listeners
    // have observed the report.
    if (recordEncoding && this.encoding && base.totalTokens > 0) {
      for (const sec of base.sections) {
        if (!sec.content || sec.actualTokens <= 0) continue;
        this.encoding.record(sec.content, { tokens: sec.actualTokens });
      }
    }

    return plan;
  }

  private report(plan: ContextPlan): FidelityReport {
    return this.wrap(plan, /*recordEncoding*/ false).fidelityReport;
  }
}
