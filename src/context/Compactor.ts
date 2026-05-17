/**
 * @packageDocumentation
 * @module Compactor
 * @description
 * Compaction strategies for the homeostatic context cycle.
 *
 * The {@link HomeostaticContextEngine} decides *when* to compact;
 * compactors decide *how*. A compactor takes a compiled plan plus the
 * trigger that fired and returns a smaller list of section inputs that
 * the engine re-compiles. The result is the "rewrite" step in the
 * accumulate → compress → rewrite → shed cycle from the Root Theorem.
 *
 * Two implementations ship out of the box:
 *
 *   - {@link DeterministicCompactor} — no LLM calls. Drops the lowest
 *     priority sections from compactable sources until the prompt
 *     fits under `compactionThreshold · P_gate`. Cheap, predictable,
 *     and safe by default.
 *   - {@link LLMRewriteCompactor} — delegates to an injected
 *     `summarise(text, budget)` function for content-preserving
 *     compression. Recommended for episodic memory and long tool
 *     outputs; pair with a cheap fast model.
 *
 * Both implementations honour `protectedSources` (system, instructions,
 * policy_overlay, trust_constraints, run_state by default) and never
 * rewrite the highest-priority sections.
 */

import type {
  ContextPlan,
  ContextSection,
  ContextSectionInput,
  ContextSource,
} from '../types/context';
import type { CompactionTrigger } from './HomeostaticContextEngine';
import type { FidelityModel } from './FidelityModel';

/** Input to a compactor: the trigger plus the produced plan. */
export interface CompactionRequest {
  /** The trigger that fired (already includes the plan). */
  trigger: CompactionTrigger;
  /** Fidelity model used to size the rewrite budget. */
  fidelityModel: FidelityModel;
  /** Target fidelity the engine is trying to hold. */
  fidelityTarget: number;
  /** Compaction threshold (typically 0.5). */
  compactionThreshold: number;
  /** Per-source allowlist override. */
  protectedSources?: ReadonlySet<ContextSource>;
}

/** Outcome of a compaction pass. */
export interface CompactionResult {
  /**
   * Rewritten section inputs. Callers should hand these back to the
   * compiler to produce a new {@link ContextPlan}. Sections may be
   * reordered, merged, replaced with summaries, or dropped entirely.
   */
  sections: ContextSectionInput[];
  /** Per-section actions taken, for tracing. */
  actions: CompactionAction[];
  /** Total tokens shed (positive integer). */
  tokensShed: number;
  /** Free-form notes the compactor wants to surface. */
  notes?: string;
}

export type CompactionActionKind = 'kept' | 'dropped' | 'truncated' | 'summarised';

export interface CompactionAction {
  sectionId: string;
  source: ContextSource;
  kind: CompactionActionKind;
  tokensBefore: number;
  tokensAfter: number;
  reason?: string;
}

/** The contract every compactor implements. */
export interface Compactor {
  /** Identifier for traces / config. */
  readonly id: string;
  /** Perform compaction. MUST NOT mutate the request. */
  compact(request: CompactionRequest): Promise<CompactionResult>;
}

/**
 * Sources whose content is governed/critical and never modified by
 * compaction. Tools and memory live OUTSIDE this set by design — they
 * are the primary compactable signal.
 */
export const DEFAULT_PROTECTED_SOURCES: ReadonlySet<ContextSource> = new Set<ContextSource>([
  'system',
  'instructions',
  'policy_overlay',
  'trust_constraints',
  'payment_constraints',
  'run_state',
  'budget',
]);

function isProtected(
  source: ContextSource,
  override?: ReadonlySet<ContextSource>,
): boolean {
  return (override ?? DEFAULT_PROTECTED_SOURCES).has(source);
}

/** ~4 chars per token; matches ContextCompiler's heuristic. */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Deterministic compactor. Drops the lowest-priority compactable
 * sections (or head-truncates them) until the plan fits under the
 * homeostatic budget. Never calls an LLM.
 */
export class DeterministicCompactor implements Compactor {
  readonly id = 'deterministic';

  async compact(request: CompactionRequest): Promise<CompactionResult> {
    const { trigger, fidelityModel, fidelityTarget, compactionThreshold } = request;
    const targetTokens = Math.floor(
      compactionThreshold * fidelityModel.pGate(fidelityTarget),
    );
    const protectedSet = request.protectedSources;
    const actions: CompactionAction[] = [];

    // Snapshot the original sections, oldest-first ordering preserved.
    const sections = [...trigger.plan.sections];

    // Compactable sections sorted by (priority asc, length desc) — cheapest
    // wins first.
    const compactable = sections
      .map((s, idx) => ({ section: s, idx }))
      .filter((s) => !isProtected(s.section.source, protectedSet))
      .sort((a, b) => {
        if (a.section.priority !== b.section.priority) {
          return a.section.priority - b.section.priority;
        }
        return b.section.actualTokens - a.section.actualTokens;
      });

    let currentTotal = trigger.plan.totalTokens;
    const dropped = new Set<number>();
    const truncated = new Map<number, string>();

    for (const { section, idx } of compactable) {
      if (currentTotal <= targetTokens) break;
      const excess = currentTotal - targetTokens;
      if (section.actualTokens <= excess + 1) {
        // Drop the whole section.
        dropped.add(idx);
        currentTotal -= section.actualTokens;
        actions.push({
          sectionId: section.id,
          source: section.source,
          kind: 'dropped',
          tokensBefore: section.actualTokens,
          tokensAfter: 0,
          reason: 'low-priority dropped to restore fidelity',
        });
      } else {
        // Head-truncate to release `excess` tokens.
        const keepTokens = section.actualTokens - excess;
        const keepChars = Math.max(0, keepTokens * 4);
        const tailContent = section.content.slice(-keepChars);
        truncated.set(idx, tailContent);
        const newTokens = estimateTokens(tailContent);
        currentTotal -= section.actualTokens - newTokens;
        actions.push({
          sectionId: section.id,
          source: section.source,
          kind: 'truncated',
          tokensBefore: section.actualTokens,
          tokensAfter: newTokens,
          reason: 'head-truncated to fit homeostatic budget',
        });
      }
    }

    // Materialise the rewritten section list, preserving original order
    // for sections we kept.
    const out: ContextSectionInput[] = [];
    for (let i = 0; i < sections.length; i++) {
      if (dropped.has(i)) continue;
      const s = sections[i];
      if (truncated.has(i)) {
        out.push(asInput(s, truncated.get(i)!));
        continue;
      }
      if (isProtected(s.source, protectedSet)) {
        out.push(asInput(s, s.content));
        actions.push({
          sectionId: s.id,
          source: s.source,
          kind: 'kept',
          tokensBefore: s.actualTokens,
          tokensAfter: s.actualTokens,
          reason: 'protected source',
        });
        continue;
      }
      out.push(asInput(s, s.content));
      actions.push({
        sectionId: s.id,
        source: s.source,
        kind: 'kept',
        tokensBefore: s.actualTokens,
        tokensAfter: s.actualTokens,
      });
    }

    return {
      sections: out,
      actions,
      tokensShed: Math.max(0, trigger.plan.totalTokens - currentTotal),
      notes: `targetTokens=${targetTokens}`,
    };
  }
}

/** Function used by {@link LLMRewriteCompactor} to compress a section. */
export type SummariseFn = (input: {
  content: string;
  source: ContextSource;
  sectionId: string;
  /** Approximate token budget the summary must respect. */
  budgetTokens: number;
}) => Promise<string>;

/**
 * LLM-rewrite compactor. Summarises low-priority compactable sections
 * down to a target fraction of their original size. Falls back to the
 * deterministic strategy when summarisation throws.
 */
export class LLMRewriteCompactor implements Compactor {
  readonly id = 'llm-rewrite';
  private readonly fallback = new DeterministicCompactor();

  /**
   * @param summarise Pluggable summarisation function.
   * @param shrinkRatio Target ratio of summary length to original
   *   length (e.g. 0.25 keeps ~25% of tokens). Defaults to 0.3.
   */
  constructor(
    private readonly summarise: SummariseFn,
    private readonly shrinkRatio: number = 0.3,
  ) {
    if (!Number.isFinite(shrinkRatio) || shrinkRatio <= 0 || shrinkRatio >= 1) {
      throw new Error(
        `LLMRewriteCompactor: shrinkRatio must be in (0, 1), got ${shrinkRatio}`,
      );
    }
  }

  async compact(request: CompactionRequest): Promise<CompactionResult> {
    const { trigger, fidelityModel, fidelityTarget, compactionThreshold } = request;
    const targetTokens = Math.floor(
      compactionThreshold * fidelityModel.pGate(fidelityTarget),
    );
    const protectedSet = request.protectedSources;
    const actions: CompactionAction[] = [];

    const sections = [...trigger.plan.sections];
    const compactable = sections
      .map((s, idx) => ({ section: s, idx }))
      .filter((s) => !isProtected(s.section.source, protectedSet))
      .sort((a, b) => a.section.priority - b.section.priority);

    let currentTotal = trigger.plan.totalTokens;
    const rewrites = new Map<number, string>();

    for (const { section, idx } of compactable) {
      if (currentTotal <= targetTokens) break;
      const budgetTokens = Math.max(64, Math.floor(section.actualTokens * this.shrinkRatio));
      try {
        const summary = await this.summarise({
          content: section.content,
          source: section.source,
          sectionId: section.id,
          budgetTokens,
        });
        const newTokens = estimateTokens(summary);
        if (newTokens >= section.actualTokens) {
          // Summary didn't help — skip and let fallback take over later.
          continue;
        }
        rewrites.set(idx, summary);
        currentTotal -= section.actualTokens - newTokens;
        actions.push({
          sectionId: section.id,
          source: section.source,
          kind: 'summarised',
          tokensBefore: section.actualTokens,
          tokensAfter: newTokens,
          reason: `LLM-rewrite @ shrinkRatio=${this.shrinkRatio}`,
        });
      } catch (err) {
        // Swallow — fallback path handles it below.
        actions.push({
          sectionId: section.id,
          source: section.source,
          kind: 'kept',
          tokensBefore: section.actualTokens,
          tokensAfter: section.actualTokens,
          reason: `summarise failed: ${(err as Error).message}`,
        });
      }
    }

    // If still over budget, hand off to deterministic compaction over
    // the rewritten plan.
    if (currentTotal > targetTokens) {
      const partialPlan = {
        ...trigger.plan,
        sections: sections.map((s, i) =>
          rewrites.has(i)
            ? { ...s, content: rewrites.get(i)!, actualTokens: estimateTokens(rewrites.get(i)!) }
            : s,
        ),
        totalTokens: currentTotal,
      };
      const fallbackTrigger: CompactionTrigger = {
        ...trigger,
        promptTokens: currentTotal,
        plan: partialPlan,
      };
      const fallbackResult = await this.fallback.compact({
        ...request,
        trigger: fallbackTrigger,
      });
      return {
        sections: fallbackResult.sections,
        actions: [...actions, ...fallbackResult.actions],
        tokensShed: Math.max(
          0,
          trigger.plan.totalTokens - estimatePlanTokens(fallbackResult.sections),
        ),
        notes: `llm-rewrite + deterministic fallback; targetTokens=${targetTokens}`,
      };
    }

    const out: ContextSectionInput[] = sections.map((s, i) =>
      asInput(s, rewrites.get(i) ?? s.content),
    );

    return {
      sections: out,
      actions,
      tokensShed: Math.max(0, trigger.plan.totalTokens - currentTotal),
      notes: `targetTokens=${targetTokens}`,
    };
  }
}

// ── Helpers ──

function asInput(section: ContextSection, content: string): ContextSectionInput {
  return {
    id: section.id,
    source: section.source,
    content,
    priority: section.priority,
    budgetTokens: section.budgetTokens || undefined,
    truncation: section.truncation,
  };
}

function estimatePlanTokens(sections: ContextSectionInput[]): number {
  return sections.reduce((acc, s) => acc + estimateTokens(s.content), 0);
}
