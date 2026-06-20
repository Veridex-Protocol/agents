/**
 * @packageDocumentation
 * @module ContinuationStrategy
 * @description
 * Long-horizon continuation strategies — Phase 5 item #2.
 *
 * The "ralph loop" pattern: when a run nears its effective context
 * window, instead of compacting *in place* (which still pays for the
 * accumulated tokens on every subsequent turn), the runtime persists
 * a tight summary of progress, ends the run, and starts a fresh one
 * that injects the original goal plus the summary. This is the only
 * known way to run hour-long autonomous agents without drift.
 *
 * Design:
 *   - {@link ContinuationStrategy} is a pure decision module — given a
 *     run snapshot, it returns either `none` (keep going) or
 *     `continue` (persist and restart) with a summary.
 *   - The runtime wires this in by checking after every turn (or on
 *     `compaction_required`); persistence and restart are caller
 *     concerns — the strategy only decides *what* to carry forward.
 *   - {@link RalphContinuationStrategy} fires when fidelity drops below
 *     a threshold OR the turn count exceeds a budget; it produces a
 *     {@link ContinuationDecision} with the goal, the latest summary,
 *     and a `continuationId` linking child runs to the original.
 *   - The summary is built deterministically from the run's transcript
 *     so test runs are reproducible; production wires in an LLM-backed
 *     summariser via the optional `summariseFn` hook.
 */

import type { ContextPlan } from '../types/context';

/** A read-only snapshot the strategy uses to decide. */
export interface ContinuationContext {
  /** The original goal/input that started this lineage. */
  goal: string;
  /** Continuation lineage id — same across all linked runs. */
  continuationId: string;
  /** Current run id. */
  runId: string;
  /** 0-based turn index that just completed. */
  turnIndex: number;
  /** Latest fidelity report from {@link HomeostaticContextEngine}. */
  fidelity?: {
    fidelity: number;
    fidelityTarget: number;
    pGate: number;
    pGateUsage: number;
    compactionTriggered: boolean;
  };
  /** Latest compiled context plan (used by summarisers). */
  latestPlan?: ContextPlan;
  /** Compact textual record of turns so the strategy can summarise. */
  turns: ReadonlyArray<ContinuationTurnRecord>;
  /** Memory snapshot — opaque so backends can vary. */
  memorySnapshot?: unknown;
}

export interface ContinuationTurnRecord {
  index: number;
  /** Short label: `'user'`, `'assistant'`, `'tool:foo'`. */
  role: string;
  /** Brief text content. */
  text: string;
}

/** Strategy verdict. */
export type ContinuationDecision =
  | { kind: 'none' }
  | {
      kind: 'continue';
      /** Goal text to inject into the next run. */
      goal: string;
      /** Carry-over summary (memo of what's done, what's left). */
      summary: string;
      /** Carry-over memory writes the next run should rehydrate. */
      memoryCarryover?: ReadonlyArray<{ id: string; content: string }>;
      /** Reason for tracing. */
      reason: string;
      /** Continuation id (stable across the lineage). */
      continuationId: string;
      /** Sequential index in the lineage (0 = first child). */
      lineageIndex: number;
    };

export interface ContinuationStrategy {
  readonly id: string;
  decide(ctx: ContinuationContext): Promise<ContinuationDecision> | ContinuationDecision;
}

// ── Ralph implementation ─────────────────────────────────────────────────

export type SummariseFn = (input: {
  goal: string;
  turns: ReadonlyArray<ContinuationTurnRecord>;
  lineageIndex: number;
}) => Promise<string> | string;

export interface RalphContinuationOptions {
  /**
   * Fire when `fidelity < target * fidelityFloor`. Default `0.85` —
   * i.e. when fidelity has dropped 15% below target.
   */
  fidelityFloor?: number;
  /** Also fire after this many turns regardless of fidelity. */
  maxTurns?: number;
  /** Also fire when {@link ContinuationContext.fidelity.compactionTriggered} is true. */
  fireOnCompaction?: boolean;
  /**
   * Optional summariser. Default is a deterministic head/tail
   * truncation that captures the goal, last 5 turns, and any
   * tool-failure turns.
   */
  summariseFn?: SummariseFn;
  /** Strategy id override. */
  id?: string;
  /**
   * Track lineage in-process. Tests usually pass `false` and supply
   * `lineageIndex` via `decide`'s `ctx`-side memo.
   */
  trackLineage?: boolean;
}

const DEFAULT_FIDELITY_FLOOR = 0.85;
const DEFAULT_MAX_TURNS = 40;

/**
 * Ralph loop strategy: persist & restart when fidelity dips, when
 * the turn budget is hit, or when the homeostatic engine signals
 * compaction.
 */
export class RalphContinuationStrategy implements ContinuationStrategy {
  readonly id: string;
  private readonly floor: number;
  private readonly maxTurns: number;
  private readonly fireOnCompaction: boolean;
  private readonly summariseFn: SummariseFn;
  private readonly lineage = new Map<string, number>();
  private readonly track: boolean;

  constructor(options: RalphContinuationOptions = {}) {
    this.id = options.id ?? 'ralph';
    this.floor = options.fidelityFloor ?? DEFAULT_FIDELITY_FLOOR;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.fireOnCompaction = options.fireOnCompaction ?? true;
    this.summariseFn = options.summariseFn ?? defaultSummarise;
    this.track = options.trackLineage ?? true;
  }

  async decide(ctx: ContinuationContext): Promise<ContinuationDecision> {
    const reasons: string[] = [];
    if (
      ctx.fidelity &&
      ctx.fidelity.fidelity < ctx.fidelity.fidelityTarget * this.floor
    ) {
      reasons.push(
        `fidelity ${ctx.fidelity.fidelity.toFixed(3)} below floor ` +
          `${(ctx.fidelity.fidelityTarget * this.floor).toFixed(3)}`,
      );
    }
    if (this.fireOnCompaction && ctx.fidelity?.compactionTriggered) {
      reasons.push('compaction_required');
    }
    if (ctx.turnIndex + 1 >= this.maxTurns) {
      reasons.push(`turn_budget_exhausted (${ctx.turnIndex + 1}/${this.maxTurns})`);
    }
    if (reasons.length === 0) {
      return { kind: 'none' };
    }

    const prev = this.track ? this.lineage.get(ctx.continuationId) ?? -1 : -1;
    const lineageIndex = prev + 1;
    if (this.track) this.lineage.set(ctx.continuationId, lineageIndex);

    const summary = await this.summariseFn({
      goal: ctx.goal,
      turns: ctx.turns,
      lineageIndex,
    });

    return {
      kind: 'continue',
      goal: ctx.goal,
      summary,
      reason: reasons.join('; '),
      continuationId: ctx.continuationId,
      lineageIndex,
    };
  }

  /** Reset lineage tracking (used by tests / suspended runs). */
  reset(): void {
    this.lineage.clear();
  }
}

/**
 * Deterministic fallback summariser. Captures:
 *   - the goal verbatim
 *   - the last `keep` turns
 *   - any earlier turns whose text contains `error` / `failed`
 */
export function defaultSummarise(input: {
  goal: string;
  turns: ReadonlyArray<ContinuationTurnRecord>;
  lineageIndex: number;
}): string {
  const keep = 5;
  const recent = input.turns.slice(-keep);
  const failures = input.turns
    .slice(0, Math.max(0, input.turns.length - keep))
    .filter(
      (t) =>
        /error|failed|exception|denied|timeout/i.test(t.text) &&
        t.text.trim().length > 0,
    );
  const lines: string[] = [
    `# Continuation #${input.lineageIndex + 1}`,
    '',
    '## Original goal',
    input.goal.trim(),
    '',
  ];
  if (failures.length > 0) {
    lines.push('## Notable issues');
    for (const f of failures) {
      lines.push(`- [turn ${f.index}] ${truncate(f.text, 200)}`);
    }
    lines.push('');
  }
  lines.push('## Recent activity (latest first)');
  for (const t of [...recent].reverse()) {
    lines.push(`- [turn ${t.index}] ${t.role}: ${truncate(t.text, 200)}`);
  }
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  const trimmed = s.trim();
  return trimmed.length <= n ? trimmed : `${trimmed.slice(0, n - 1)}…`;
}
