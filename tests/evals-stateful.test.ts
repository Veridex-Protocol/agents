import { describe, it, expect } from 'vitest';
import {
  diffMemorySnapshots,
  RubricStateJudge,
  runStatefulScenarios,
  compareTrajectories,
  gateRegressions,
  type StatefulTrajectory,
  type StateRubricCriterion,
  type MemorySnapshot,
} from '../src/evals/stateful';

function snap(turnIndex: number, entries: MemorySnapshot['entries']): MemorySnapshot {
  return { turnIndex, capturedAt: turnIndex * 1000, entries };
}

function trajectory(
  scenarioId: string,
  finalMemory: MemorySnapshot,
  text = 'final',
): StatefulTrajectory {
  return {
    scenarioId,
    goal: 'g',
    output: text,
    durationMs: 10,
    turns: [
      {
        turnIndex: 0,
        role: 'user',
        text: 'hi',
        memory: snap(0, []),
      },
      {
        turnIndex: 1,
        role: 'assistant',
        text,
        memory: finalMemory,
      },
    ],
  };
}

describe('diffMemorySnapshots', () => {
  it('detects add, remove, content + confidence + tag changes', () => {
    const before = snap(0, [
      { id: 'a', tier: 'core', content: 'one', confidence: 0.5, tags: ['x'] },
      { id: 'b', tier: 'core', content: 'two' },
    ]);
    const after = snap(1, [
      { id: 'a', tier: 'core', content: 'one updated', confidence: 0.9, tags: ['x', 'y'] },
      { id: 'c', tier: 'episodic', content: 'new' },
    ]);
    const d = diffMemorySnapshots(before, after);
    expect(d.added.map((e) => e.id)).toEqual(['c']);
    expect(d.removed.map((e) => e.id)).toEqual(['b']);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0].fields.sort()).toEqual(['confidence', 'content', 'tags']);
  });
});

describe('RubricStateJudge', () => {
  it('passes when memory entry matches', async () => {
    const judge = new RubricStateJudge();
    const traj = trajectory('s', snap(1, [
      { id: 'fact', tier: 'core', content: 'ALPHA learned', confidence: 0.8, tags: ['v'] },
    ]));
    const rubric: StateRubricCriterion[] = [
      {
        id: 'has-fact',
        description: 'must remember alpha',
        at: 'final',
        memoryEntryId: 'fact',
        requiresContent: 'ALPHA',
        minConfidence: 0.5,
        requiresTags: ['v'],
      },
    ];
    const results = await judge.judge(traj, rubric);
    expect(results[0].pass).toBe(true);
  });

  it('fails with reason on missing entry', async () => {
    const judge = new RubricStateJudge();
    const traj = trajectory('s', snap(1, []));
    const results = await judge.judge(traj, [
      { id: 'r1', description: 'x', at: 'final', memoryEntryId: 'missing' },
    ]);
    expect(results[0].pass).toBe(false);
    expect(results[0].reason).toContain('missing');
  });

  it('checks outputContains', async () => {
    const judge = new RubricStateJudge();
    const traj = trajectory('s', snap(1, []), 'task complete');
    const results = await judge.judge(traj, [
      { id: 'r', description: 'x', at: 'final', outputContains: 'complete' },
    ]);
    expect(results[0].pass).toBe(true);
  });

  it('supports custom predicate', async () => {
    const judge = new RubricStateJudge();
    const traj = trajectory('s', snap(1, [{ id: 'a', tier: 't', content: 'z' }]));
    const results = await judge.judge(traj, [
      {
        id: 'r',
        description: 'x',
        at: 'final',
        predicate: (s) => s.memory.entries.length === 1,
      },
    ]);
    expect(results[0].pass).toBe(true);
  });
});

describe('runStatefulScenarios + compareTrajectories', () => {
  it('aggregates pass/fail counts', async () => {
    const traj = (id: string, content: string): StatefulTrajectory =>
      trajectory(id, snap(1, [{ id: 'fact', tier: 'core', content, confidence: 1 }]));
    const report = await runStatefulScenarios([
      {
        id: 'a',
        goal: 'g',
        rubric: [
          {
            id: 'c1',
            description: 'x',
            at: 'final',
            memoryEntryId: 'fact',
            requiresContent: 'good',
          },
        ],
        execute: async () => traj('a', 'good'),
      },
      {
        id: 'b',
        goal: 'g',
        rubric: [
          {
            id: 'c1',
            description: 'x',
            at: 'final',
            memoryEntryId: 'fact',
            requiresContent: 'good',
          },
        ],
        execute: async () => traj('b', 'bad'),
      },
    ]);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
  });

  it('detects regressions vs. baseline', async () => {
    const traj = (id: string, content: string): StatefulTrajectory =>
      trajectory(id, snap(1, [{ id: 'fact', tier: 'core', content }]));
    const rubric: StateRubricCriterion[] = [
      {
        id: 'c1',
        description: 'x',
        at: 'final',
        memoryEntryId: 'fact',
        requiresContent: 'good',
      },
    ];
    const baseline = await runStatefulScenarios([
      { id: 'a', goal: 'g', rubric, execute: async () => traj('a', 'good') },
    ]);
    const current = await runStatefulScenarios([
      { id: 'a', goal: 'g', rubric, execute: async () => traj('a', 'bad') },
    ]);
    const report = compareTrajectories(baseline, current);
    expect(report.regressed).toBe(true);
    expect(report.summary.newFailures).toBe(1);
    expect(gateRegressions(report)).toBe(1);
  });
});
