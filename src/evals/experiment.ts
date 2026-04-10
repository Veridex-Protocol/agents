/**
 * @module experiment
 *
 * Harness hill-climbing experiment loop inspired by LangChain's better-harness.
 *
 * Workflow:
 * 1. Run baseline variant on *train* split → record results
 * 2. Loop N iterations:
 *    a. Build a **diagnosis** from failing outcomes on the train split
 *    b. Call the user-supplied **proposer** callback with the diagnosis
 *    c. Run the proposed variant on the *train* split
 *    d. **Greedy acceptance**: keep the variant if train correctness ≥ baseline
 *    e. Optionally evaluate on *holdout* for unbiased reporting
 * 3. Produce an `ExperimentReport` summarising every iteration
 *
 * The proposer is a plain async callback, keeping the loop model-agnostic.
 */

import type { AgentDefinition } from '../types/agent';
import type { EvalScenario, EvalSplit, SplitResult, CaseOutcome } from './types';
import { runSplit, validateSplitBalance } from './runner';
import type { HarnessVariant } from './surfaces';
import { buildVariantFromDef, applyVariant, diffVariants } from './surfaces';
import type { VariantDiff } from './surfaces';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

/** Acceptance strategy for deciding whether to keep a proposed variant. */
export type AcceptanceCriteria = 'greedy' | 'strict_improve';

/** Configuration for a single experiment run. */
export interface ExperimentConfig {
  /** Unique experiment identifier. */
  experimentId: string;
  /** Human-readable name. */
  name: string;
  /** Base agent definition (the starting point). */
  baseDefinition: AgentDefinition;
  /** All scenarios, already tagged with split/stratum. */
  scenarios: EvalScenario[];
  /** Maximum optimisation iterations. */
  maxIterations: number;
  /** Acceptance strategy (default: 'greedy'). */
  acceptance?: AcceptanceCriteria;
  /** Whether to evaluate on holdout after each accepted variant (default: true). */
  evalHoldout?: boolean;
  /**
   * Proposer callback: receives a diagnosis of current failures and returns a
   * new variant to try.  The loop is model-agnostic — the caller can wire this
   * to any LLM, rule engine, or manual override.
   */
  proposer: (diagnosis: IterationDiagnosis) => Promise<HarnessVariant>;
}

/** Diagnosis payload handed to the proposer. */
export interface IterationDiagnosis {
  /** Current iteration index (0-based). */
  iteration: number;
  /** The current (best) variant being evaluated. */
  currentVariant: HarnessVariant;
  /** The current agent definition (with the variant applied). */
  currentDefinition: AgentDefinition;
  /** Train split result from the current variant. */
  trainResult: SplitResult;
  /** Failing outcomes grouped by stratum (empty string key = unassigned). */
  failuresByStratum: Record<string, CaseOutcome[]>;
  /** Strata balance warnings (if any). */
  strataWarnings: string[];
  /** History of prior iterations. */
  history: IterationRecord[];
}

/** Record of a single optimisation iteration. */
export interface IterationRecord {
  /** Iteration index (0-based). */
  iteration: number;
  /** Variant that was evaluated. */
  variant: HarnessVariant;
  /** Diff relative to previous variant. */
  diff: VariantDiff;
  /** Train split result. */
  trainResult: SplitResult;
  /** Holdout split result (if evaluated). */
  holdoutResult?: SplitResult;
  /** Whether this variant was accepted. */
  accepted: boolean;
  /** Timestamp when this iteration completed. */
  completedAt: number;
}

/** Final report for an experiment run. */
export interface ExperimentReport {
  /** Experiment configuration echo. */
  experimentId: string;
  name: string;
  /** Total wall-clock duration in ms. */
  durationMs: number;
  /** Number of iterations executed. */
  totalIterations: number;
  /** Number of accepted variants. */
  acceptedIterations: number;
  /** Baseline result (iteration 0, before any proposals). */
  baselineTrainResult: SplitResult;
  /** Final (best) train result. */
  finalTrainResult: SplitResult;
  /** Final holdout result (if evaluated). */
  finalHoldoutResult?: SplitResult;
  /** The winning variant. */
  bestVariant: HarnessVariant;
  /** The winning agent definition. */
  bestDefinition: AgentDefinition;
  /** Full iteration history. */
  iterations: IterationRecord[];
  /** Strata balance warnings. */
  strataWarnings: string[];
  /** Serialise the report. */
  toJSON(): Record<string, unknown>;
  /** Markdown summary. */
  toMarkdown(): string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function groupFailuresByStratum(outcomes: CaseOutcome[]): Record<string, CaseOutcome[]> {
  const map: Record<string, CaseOutcome[]> = {};
  for (const o of outcomes) {
    if (o.status === 'passed' || o.status === 'skipped') continue;
    const key = o.stratum ?? '';
    if (!map[key]) map[key] = [];
    map[key].push(o);
  }
  return map;
}

function meetsAcceptance(
  criteria: AcceptanceCriteria,
  proposed: SplitResult,
  current: SplitResult,
): boolean {
  switch (criteria) {
    case 'greedy':
      return proposed.correctness >= current.correctness;
    case 'strict_improve':
      return proposed.correctness > current.correctness;
    default:
      return proposed.correctness >= current.correctness;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Core loop
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run an experiment: baseline → iterate [diagnose → propose → eval → accept/reject] → report.
 */
export async function runExperiment(config: ExperimentConfig): Promise<ExperimentReport> {
  const start = Date.now();
  const acceptance = config.acceptance ?? 'greedy';
  const evalHoldout = config.evalHoldout ?? true;

  // Validate strata balance
  const strataValidation = validateSplitBalance(config.scenarios);
  const strataWarnings = strataValidation.warnings;

  // ── Baseline ──
  let currentVariant = buildVariantFromDef('baseline', config.baseDefinition);
  let currentDef = config.baseDefinition;
  let currentTrainResult = await runSplit(config.scenarios, 'train', 'baseline');

  const baselineTrainResult = currentTrainResult;
  const iterations: IterationRecord[] = [];

  // ── Iteration loop ──
  for (let i = 0; i < config.maxIterations; i++) {
    const failuresByStratum = groupFailuresByStratum(currentTrainResult.outcomes);

    const diagnosis: IterationDiagnosis = {
      iteration: i,
      currentVariant,
      currentDefinition: currentDef,
      trainResult: currentTrainResult,
      failuresByStratum,
      strataWarnings,
      history: iterations,
    };

    // If train is already perfect, stop early
    if (currentTrainResult.correctness >= 1.0) {
      break;
    }

    // Propose
    const proposedVariant = await config.proposer(diagnosis);
    const proposedDef = applyVariant(proposedVariant, config.baseDefinition);

    // Evaluate proposed on train
    const proposedTrainResult = await runSplit(config.scenarios, 'train', proposedVariant.label);
    const diff = diffVariants(currentVariant, proposedVariant);

    // Accept/reject
    const accepted = meetsAcceptance(acceptance, proposedTrainResult, currentTrainResult);

    // Optionally evaluate holdout
    let holdoutResult: SplitResult | undefined;
    if (evalHoldout && accepted) {
      holdoutResult = await runSplit(config.scenarios, 'holdout', proposedVariant.label);
    }

    iterations.push({
      iteration: i,
      variant: proposedVariant,
      diff,
      trainResult: proposedTrainResult,
      holdoutResult,
      accepted,
      completedAt: Date.now(),
    });

    if (accepted) {
      currentVariant = proposedVariant;
      currentDef = proposedDef;
      currentTrainResult = proposedTrainResult;
    }
  }

  // ── Final holdout ──
  let finalHoldoutResult: SplitResult | undefined;
  if (evalHoldout) {
    finalHoldoutResult = await runSplit(config.scenarios, 'holdout', currentVariant.label);
  }

  // ── Build report ──
  const report: ExperimentReport = {
    experimentId: config.experimentId,
    name: config.name,
    durationMs: Date.now() - start,
    totalIterations: iterations.length,
    acceptedIterations: iterations.filter((r) => r.accepted).length,
    baselineTrainResult,
    finalTrainResult: currentTrainResult,
    finalHoldoutResult,
    bestVariant: currentVariant,
    bestDefinition: currentDef,
    iterations,
    strataWarnings,
    toJSON() {
      return {
        experimentId: this.experimentId,
        name: this.name,
        durationMs: this.durationMs,
        totalIterations: this.totalIterations,
        acceptedIterations: this.acceptedIterations,
        baselineCorrectness: this.baselineTrainResult.correctness,
        finalTrainCorrectness: this.finalTrainResult.correctness,
        finalHoldoutCorrectness: this.finalHoldoutResult?.correctness ?? null,
        iterations: this.iterations.map((it) => ({
          iteration: it.iteration,
          variant: it.variant.label,
          diff: it.diff.summary,
          trainCorrectness: it.trainResult.correctness,
          holdoutCorrectness: it.holdoutResult?.correctness ?? null,
          accepted: it.accepted,
        })),
        strataWarnings: this.strataWarnings,
      };
    },
    toMarkdown() {
      const lines: string[] = [];
      lines.push(`# Experiment: ${this.name}`);
      lines.push('');
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Iterations | ${this.totalIterations} |`);
      lines.push(`| Accepted | ${this.acceptedIterations} |`);
      lines.push(
        `| Baseline Train | ${(this.baselineTrainResult.correctness * 100).toFixed(1)}% |`,
      );
      lines.push(`| Final Train | ${(this.finalTrainResult.correctness * 100).toFixed(1)}% |`);
      if (this.finalHoldoutResult) {
        lines.push(
          `| Final Holdout | ${(this.finalHoldoutResult.correctness * 100).toFixed(1)}% |`,
        );
      }
      lines.push(`| Duration | ${this.durationMs}ms |`);
      lines.push('');

      if (this.iterations.length > 0) {
        lines.push('## Iterations');
        lines.push('');
        lines.push('| # | Variant | Diff | Train | Holdout | Accepted |');
        lines.push('|---|---------|------|-------|---------|----------|');
        for (const it of this.iterations) {
          const train = (it.trainResult.correctness * 100).toFixed(1);
          const holdout = it.holdoutResult
            ? (it.holdoutResult.correctness * 100).toFixed(1)
            : '-';
          lines.push(
            `| ${it.iteration} | ${it.variant.label} | ${it.diff.summary} | ${train}% | ${holdout}% | ${it.accepted ? '✅' : '❌'} |`,
          );
        }
      }

      if (this.strataWarnings.length > 0) {
        lines.push('');
        lines.push('## Warnings');
        for (const w of this.strataWarnings) {
          lines.push(`- ${w}`);
        }
      }

      return lines.join('\n');
    },
  };

  return report;
}
