/**
 * @packageDocumentation
 * @module ContinuationCoordinator
 * @description
 * High-level helper that drives a {@link ContinuationStrategy} across
 * multiple consecutive runs. Tests + production wire this in as
 * `coordinator.runUntilDone(goal)` and get a single coherent
 * trajectory that survives compaction-driven restarts.
 */

import type {
  ContinuationContext,
  ContinuationDecision,
  ContinuationStrategy,
  ContinuationTurnRecord,
} from './ContinuationStrategy';

/** The minimal run interface the coordinator needs. */
export interface RunHandle {
  runId: string;
  /** Final assistant output. */
  output?: string;
  /** Whether the run terminated by reaching `done` (vs. error/timeout). */
  done: boolean;
  /** Turn records used by the strategy to summarise. */
  turns: ReadonlyArray<ContinuationTurnRecord>;
  /** Latest fidelity reading, if available. */
  fidelity?: ContinuationContext['fidelity'];
  /** Memory snapshot the next run should rehydrate. */
  memorySnapshot?: unknown;
}

/**
 * A user-supplied runner: given the next prompt + carry-over context,
 * execute one run and return its handle. The coordinator does not
 * own the runtime — it just drives it.
 */
export type ContinuationRunner = (input: ContinuationRunnerInput) => Promise<RunHandle>;

export interface ContinuationRunnerInput {
  /** Goal to inject. */
  goal: string;
  /** Continuation lineage id. `null` on the first run. */
  continuationId: string | null;
  /** Sequential lineage index. `0` on the first run. */
  lineageIndex: number;
  /** Carry-over summary from the previous run, or `null`. */
  carryoverSummary: string | null;
  /** Carry-over memory writes, or empty. */
  memoryCarryover: ReadonlyArray<{ id: string; content: string }>;
  /** Memory snapshot from the previous run, or `null`. */
  memorySnapshot: unknown;
}

export interface ContinuationCoordinatorOptions {
  /** Strategy. Defaults to a `RalphContinuationStrategy`. */
  strategy: ContinuationStrategy;
  /** Runner that executes one run. */
  runner: ContinuationRunner;
  /** Max total runs in a lineage. Default `8`. */
  maxRuns?: number;
  /** Continuation-id generator. Default: `c_<random>`. */
  generateId?: () => string;
}

/** Output of a complete lineage. */
export interface ContinuationLineageResult {
  continuationId: string;
  totalRuns: number;
  runs: RunHandle[];
  decisions: ContinuationDecision[];
  /** Output of the final run. */
  output: string | undefined;
  /** Whether the final run completed. */
  done: boolean;
  /** Reason the lineage stopped (`done` | `max_runs` | `runner_failed`). */
  stopReason: 'done' | 'max_runs' | 'runner_failed';
}

export class ContinuationCoordinator {
  private readonly strategy: ContinuationStrategy;
  private readonly runner: ContinuationRunner;
  private readonly maxRuns: number;
  private readonly generateId: () => string;

  constructor(options: ContinuationCoordinatorOptions) {
    this.strategy = options.strategy;
    this.runner = options.runner;
    this.maxRuns = options.maxRuns ?? 8;
    this.generateId = options.generateId ?? defaultIdGen;
  }

  /**
   * Drive runs until the strategy says `none`, the runner returns
   * `done: true`, or `maxRuns` is exhausted.
   */
  async runUntilDone(goal: string): Promise<ContinuationLineageResult> {
    const continuationId = this.generateId();
    const runs: RunHandle[] = [];
    const decisions: ContinuationDecision[] = [];
    let nextInput: ContinuationRunnerInput = {
      goal,
      continuationId: null,
      lineageIndex: 0,
      carryoverSummary: null,
      memoryCarryover: [],
      memorySnapshot: null,
    };

    for (let i = 0; i < this.maxRuns; i++) {
      const handle = await this.runner(nextInput);
      runs.push(handle);
      if (!handle.done) {
        return {
          continuationId,
          totalRuns: runs.length,
          runs,
          decisions,
          output: handle.output,
          done: false,
          stopReason: 'runner_failed',
        };
      }

      const decision = await this.strategy.decide({
        goal,
        continuationId,
        runId: handle.runId,
        turnIndex: handle.turns.length - 1,
        fidelity: handle.fidelity,
        turns: handle.turns,
        memorySnapshot: handle.memorySnapshot,
      });
      decisions.push(decision);

      if (decision.kind === 'none') {
        return {
          continuationId,
          totalRuns: runs.length,
          runs,
          decisions,
          output: handle.output,
          done: true,
          stopReason: 'done',
        };
      }

      nextInput = {
        goal: decision.goal,
        continuationId,
        lineageIndex: decision.lineageIndex + 1,
        carryoverSummary: decision.summary,
        memoryCarryover: decision.memoryCarryover ?? [],
        memorySnapshot: handle.memorySnapshot ?? null,
      };
    }

    return {
      continuationId,
      totalRuns: runs.length,
      runs,
      decisions,
      output: runs[runs.length - 1]?.output,
      done: false,
      stopReason: 'max_runs',
    };
  }
}

function defaultIdGen(): string {
  return `c_${Math.random().toString(36).slice(2, 10)}`;
}
