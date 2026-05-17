/**
 * @packageDocumentation
 * @module StatefulEvals
 * @description
 * Stateful evaluation harness — Phase 5 item #6.
 *
 * Why this exists:
 *   Stateless evals miss the entire point of agents: state evolves
 *   across turns, and regressions show up as *what the agent
 *   remembered*, not what it said in any single turn. Letta Evals
 *   pioneered this; we ship the same primitives plus regression gates
 *   so CI can fail when memory contents change unexpectedly.
 *
 * Design:
 *   - {@link StatefulTrajectory} captures per-turn state snapshots
 *     (memory entries, fidelity, tool calls, output).
 *   - {@link diffMemorySnapshots} computes added/removed/changed memory
 *     entries between two turns.
 *   - {@link StateJudge} is a contract — the framework ships a pure
 *     {@link RubricStateJudge} (substring / regex matches per state)
 *     and lets users plug in an LLM-as-judge by adapting their model.
 *   - {@link compareTrajectories} produces a {@link RegressionReport}
 *     that flags new failures, fixed regressions, and absolute score
 *     deltas. {@link gateRegressions} returns the exit code CI should
 *     use — `0` on parity-or-better, `1` on regression.
 */

// ── Memory snapshot ────────────────────────────────────────────────────

export interface MemoryEntrySnapshot {
  id: string;
  /** Memory tier. */
  tier: string;
  /** Free-form content the eval compares. */
  content: string;
  /** Confidence in [0,1]. */
  confidence?: number;
  /** Free-form tags. */
  tags?: readonly string[];
}

export interface MemorySnapshot {
  /** Logical turn index this snapshot captures. */
  turnIndex: number;
  /** Wall-clock when captured (used for monotonicity checks). */
  capturedAt: number;
  /** Memory entries at this point. */
  entries: ReadonlyArray<MemoryEntrySnapshot>;
}

export interface MemoryDiff {
  added: MemoryEntrySnapshot[];
  removed: MemoryEntrySnapshot[];
  changed: Array<{
    id: string;
    before: MemoryEntrySnapshot;
    after: MemoryEntrySnapshot;
    fields: ReadonlyArray<'content' | 'confidence' | 'tags' | 'tier'>;
  }>;
}

export function diffMemorySnapshots(
  before: MemorySnapshot,
  after: MemorySnapshot,
): MemoryDiff {
  const beforeMap = new Map(before.entries.map((e) => [e.id, e]));
  const afterMap = new Map(after.entries.map((e) => [e.id, e]));
  const added: MemoryEntrySnapshot[] = [];
  const removed: MemoryEntrySnapshot[] = [];
  const changed: MemoryDiff['changed'] = [];
  for (const [id, entry] of afterMap) {
    const b = beforeMap.get(id);
    if (!b) {
      added.push(entry);
      continue;
    }
    const fields: Array<'content' | 'confidence' | 'tags' | 'tier'> = [];
    if (b.content !== entry.content) fields.push('content');
    if ((b.confidence ?? null) !== (entry.confidence ?? null)) fields.push('confidence');
    if (b.tier !== entry.tier) fields.push('tier');
    const beforeTags = new Set(b.tags ?? []);
    const afterTags = new Set(entry.tags ?? []);
    const tagsEqual =
      beforeTags.size === afterTags.size &&
      Array.from(beforeTags).every((t) => afterTags.has(t));
    if (!tagsEqual) fields.push('tags');
    if (fields.length > 0) {
      changed.push({ id, before: b, after: entry, fields });
    }
  }
  for (const [id, entry] of beforeMap) {
    if (!afterMap.has(id)) removed.push(entry);
  }
  return { added, removed, changed };
}

// ── Trajectory ─────────────────────────────────────────────────────────

export interface TrajectoryTurnSnapshot {
  turnIndex: number;
  /** Brief role tag (`'user'`, `'assistant'`, `'tool:foo'`). */
  role: string;
  /** Text output (truncated by the caller, if needed). */
  text: string;
  /** Memory at the *end* of this turn. */
  memory: MemorySnapshot;
  /** Optional fidelity reading. */
  fidelity?: number;
  /** Tool calls invoked this turn (names only). */
  tools?: ReadonlyArray<string>;
}

export interface StatefulTrajectory {
  /** Scenario id this trajectory belongs to. */
  scenarioId: string;
  /** Goal/input that started the run. */
  goal: string;
  /** Snapshots, one per logical turn. */
  turns: ReadonlyArray<TrajectoryTurnSnapshot>;
  /** Final output. */
  output: string;
  /** Total duration in ms. */
  durationMs: number;
}

// ── Judge ──────────────────────────────────────────────────────────────

/** Per-state criterion the judge evaluates. */
export interface StateRubricCriterion {
  /** Unique id within the scenario. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Turn index to evaluate at. `'final'` = last turn. */
  at: number | 'final';
  /** Free-form severity. */
  severity?: 'critical' | 'major' | 'minor';
  /** Expected memory entry id. */
  memoryEntryId?: string;
  /** Substring required in the entry content. */
  requiresContent?: string;
  /** Regex the entry content must match. */
  requiresPattern?: RegExp;
  /** Minimum confidence. */
  minConfidence?: number;
  /** Required tags. */
  requiresTags?: readonly string[];
  /** Required output substring (when `memoryEntryId` is absent). */
  outputContains?: string;
  /** Custom predicate — most flexible escape hatch. */
  predicate?: (snapshot: TrajectoryTurnSnapshot, trajectory: StatefulTrajectory) => boolean;
}

export interface JudgeResult {
  criterionId: string;
  pass: boolean;
  /** When `false`, reason text. */
  reason?: string;
}

export interface StateJudge {
  readonly id: string;
  judge(
    trajectory: StatefulTrajectory,
    rubric: ReadonlyArray<StateRubricCriterion>,
  ): Promise<JudgeResult[]> | JudgeResult[];
}

/** Pure rubric judge — no model required. Ideal for CI gates. */
export class RubricStateJudge implements StateJudge {
  readonly id = 'rubric';
  judge(
    trajectory: StatefulTrajectory,
    rubric: ReadonlyArray<StateRubricCriterion>,
  ): JudgeResult[] {
    return rubric.map((c) => evaluateCriterion(c, trajectory));
  }
}

function evaluateCriterion(
  c: StateRubricCriterion,
  trajectory: StatefulTrajectory,
): JudgeResult {
  const idx = c.at === 'final' ? trajectory.turns.length - 1 : c.at;
  const snapshot = trajectory.turns[idx];
  if (!snapshot) {
    return {
      criterionId: c.id,
      pass: false,
      reason: `no turn at index ${c.at}`,
    };
  }
  if (c.predicate) {
    const ok = c.predicate(snapshot, trajectory);
    return ok
      ? { criterionId: c.id, pass: true }
      : { criterionId: c.id, pass: false, reason: 'predicate returned false' };
  }
  if (c.memoryEntryId) {
    const entry = snapshot.memory.entries.find((e) => e.id === c.memoryEntryId);
    if (!entry) {
      return {
        criterionId: c.id,
        pass: false,
        reason: `memory entry '${c.memoryEntryId}' missing at turn ${idx}`,
      };
    }
    if (c.requiresContent && !entry.content.includes(c.requiresContent)) {
      return {
        criterionId: c.id,
        pass: false,
        reason: `entry content does not include '${c.requiresContent}'`,
      };
    }
    if (c.requiresPattern && !c.requiresPattern.test(entry.content)) {
      return {
        criterionId: c.id,
        pass: false,
        reason: `entry content does not match ${c.requiresPattern}`,
      };
    }
    if (
      c.minConfidence !== undefined &&
      (entry.confidence ?? 0) < c.minConfidence
    ) {
      return {
        criterionId: c.id,
        pass: false,
        reason: `confidence ${entry.confidence ?? 0} < ${c.minConfidence}`,
      };
    }
    if (c.requiresTags) {
      const tags = new Set(entry.tags ?? []);
      for (const t of c.requiresTags) {
        if (!tags.has(t)) {
          return {
            criterionId: c.id,
            pass: false,
            reason: `tag '${t}' missing`,
          };
        }
      }
    }
    return { criterionId: c.id, pass: true };
  }
  if (c.outputContains) {
    const ok = snapshot.text.includes(c.outputContains);
    return ok
      ? { criterionId: c.id, pass: true }
      : {
          criterionId: c.id,
          pass: false,
          reason: `turn ${idx} output missing '${c.outputContains}'`,
        };
  }
  return {
    criterionId: c.id,
    pass: false,
    reason: 'criterion has no checks',
  };
}

// ── Stateful runner ────────────────────────────────────────────────────

export interface StatefulScenarioRun {
  scenarioId: string;
  trajectory: StatefulTrajectory;
  results: ReadonlyArray<JudgeResult>;
  passed: boolean;
}

export interface StatefulRunReport {
  total: number;
  passed: number;
  failed: number;
  runs: StatefulScenarioRun[];
}

export interface StatefulScenarioInput {
  id: string;
  goal: string;
  rubric: ReadonlyArray<StateRubricCriterion>;
  /** Caller-supplied executor producing the trajectory. */
  execute: () => Promise<StatefulTrajectory>;
}

export interface StatefulRunnerOptions {
  judge?: StateJudge;
}

export async function runStatefulScenarios(
  scenarios: ReadonlyArray<StatefulScenarioInput>,
  options: StatefulRunnerOptions = {},
): Promise<StatefulRunReport> {
  const judge = options.judge ?? new RubricStateJudge();
  const runs: StatefulScenarioRun[] = [];
  for (const s of scenarios) {
    const trajectory = await s.execute();
    const results = await judge.judge(trajectory, s.rubric);
    const passed = results.every((r) => r.pass);
    runs.push({ scenarioId: s.id, trajectory, results, passed });
  }
  return {
    total: runs.length,
    passed: runs.filter((r) => r.passed).length,
    failed: runs.filter((r) => !r.passed).length,
    runs,
  };
}

// ── Regression gating ─────────────────────────────────────────────────

export interface RegressionEntry {
  scenarioId: string;
  criterionId: string;
  kind: 'new_failure' | 'fixed' | 'still_failing' | 'still_passing';
  reasonNow?: string;
  reasonBefore?: string;
}

export interface RegressionReport {
  entries: RegressionEntry[];
  /** Strictly worse than baseline? */
  regressed: boolean;
  /** Strictly better? */
  improved: boolean;
  summary: { newFailures: number; fixed: number; stillFailing: number; stillPassing: number };
}

export function compareTrajectories(
  baseline: StatefulRunReport,
  current: StatefulRunReport,
): RegressionReport {
  const entries: RegressionEntry[] = [];
  const baselineRuns = new Map(baseline.runs.map((r) => [r.scenarioId, r]));
  for (const run of current.runs) {
    const before = baselineRuns.get(run.scenarioId);
    if (!before) continue; // new scenario; ignore for regression purposes
    const beforeByCrit = new Map(before.results.map((r) => [r.criterionId, r]));
    for (const result of run.results) {
      const prev = beforeByCrit.get(result.criterionId);
      if (!prev) continue;
      let kind: RegressionEntry['kind'];
      if (prev.pass && !result.pass) kind = 'new_failure';
      else if (!prev.pass && result.pass) kind = 'fixed';
      else if (!prev.pass && !result.pass) kind = 'still_failing';
      else kind = 'still_passing';
      entries.push({
        scenarioId: run.scenarioId,
        criterionId: result.criterionId,
        kind,
        reasonNow: result.reason,
        reasonBefore: prev.reason,
      });
    }
  }
  const newFailures = entries.filter((e) => e.kind === 'new_failure').length;
  const fixed = entries.filter((e) => e.kind === 'fixed').length;
  const stillFailing = entries.filter((e) => e.kind === 'still_failing').length;
  const stillPassing = entries.filter((e) => e.kind === 'still_passing').length;
  return {
    entries,
    regressed: newFailures > 0,
    improved: fixed > 0 && newFailures === 0,
    summary: { newFailures, fixed, stillFailing, stillPassing },
  };
}

/** Returns 0 when CI should pass, 1 when it should fail. */
export function gateRegressions(report: RegressionReport): number {
  return report.regressed ? 1 : 0;
}
