import { describe, it, expect, vi } from 'vitest';
import {
  RalphContinuationStrategy,
  defaultSummarise,
  ContinuationCoordinator,
  type ContinuationContext,
  type RunHandle,
} from '../src/runtime';

function ctx(overrides: Partial<ContinuationContext> = {}): ContinuationContext {
  return {
    goal: 'do the thing',
    continuationId: 'c1',
    runId: 'r1',
    turnIndex: 0,
    turns: [],
    ...overrides,
  };
}

describe('RalphContinuationStrategy', () => {
  it('returns none when healthy', async () => {
    const s = new RalphContinuationStrategy();
    const d = await s.decide(
      ctx({
        fidelity: {
          fidelity: 0.95,
          fidelityTarget: 1,
          pGate: 0.4,
          pGateUsage: 0.4,
          compactionTriggered: false,
        },
      }),
    );
    expect(d.kind).toBe('none');
  });

  it('fires when fidelity below floor', async () => {
    const s = new RalphContinuationStrategy({ fidelityFloor: 0.9 });
    const d = await s.decide(
      ctx({
        fidelity: {
          fidelity: 0.5,
          fidelityTarget: 1,
          pGate: 0.4,
          pGateUsage: 0.4,
          compactionTriggered: false,
        },
      }),
    );
    expect(d.kind).toBe('continue');
    if (d.kind === 'continue') {
      expect(d.reason).toMatch(/below floor/);
    }
  });

  it('fires on compactionTriggered', async () => {
    const s = new RalphContinuationStrategy();
    const d = await s.decide(
      ctx({
        fidelity: {
          fidelity: 1,
          fidelityTarget: 1,
          pGate: 0.4,
          pGateUsage: 0.4,
          compactionTriggered: true,
        },
      }),
    );
    expect(d.kind).toBe('continue');
    if (d.kind === 'continue') {
      expect(d.reason).toMatch(/compaction_required/);
    }
  });

  it('fires at turn budget', async () => {
    const s = new RalphContinuationStrategy({ maxTurns: 3 });
    const d = await s.decide(ctx({ turnIndex: 2 }));
    expect(d.kind).toBe('continue');
    if (d.kind === 'continue') {
      expect(d.reason).toMatch(/turn_budget/);
    }
  });

  it('lineage index increments per continuationId', async () => {
    const s = new RalphContinuationStrategy({ maxTurns: 1 });
    const a = await s.decide(ctx({ turnIndex: 0 }));
    const b = await s.decide(ctx({ turnIndex: 0 }));
    expect(a.kind).toBe('continue');
    expect(b.kind).toBe('continue');
    if (a.kind === 'continue' && b.kind === 'continue') {
      expect(b.lineageIndex).toBe(a.lineageIndex + 1);
    }
  });

  it('defaultSummarise captures recent turns and errors', () => {
    const turns = [
      { index: 0, role: 'user', text: 'start' },
      { index: 1, role: 'tool:x', text: 'error: rate limited' },
      { index: 2, role: 'assistant', text: 'ok' },
      { index: 3, role: 'assistant', text: 'progress' },
      { index: 4, role: 'assistant', text: 'continuing' },
      { index: 5, role: 'assistant', text: 'almost' },
      { index: 6, role: 'assistant', text: 'done step 1' },
      { index: 7, role: 'assistant', text: 'done step 2' },
    ];
    const summary = defaultSummarise({ goal: 'G', turns, lineageIndex: 0 });
    expect(summary).toContain('G');
    expect(summary).toContain('rate limited');
    expect(summary).toContain('done step 2');
  });
});

describe('ContinuationCoordinator', () => {
  it('stops with done when strategy returns none', async () => {
    const runner = vi.fn(async (): Promise<RunHandle> => ({
      runId: 'r1',
      output: 'final',
      done: true,
      turns: [],
      fidelity: {
        fidelity: 1,
        fidelityTarget: 1,
        pGate: 0.4,
        pGateUsage: 0.4,
        compactionTriggered: false,
      },
    }));
    const c = new ContinuationCoordinator({
      strategy: new RalphContinuationStrategy(),
      runner,
    });
    const r = await c.runUntilDone('goal');
    expect(r.stopReason).toBe('done');
    expect(r.output).toBe('final');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('stops on runner_failed when handle.done = false', async () => {
    const runner = vi.fn(async (): Promise<RunHandle> => ({
      runId: 'r1',
      done: false,
      turns: [],
    }));
    const c = new ContinuationCoordinator({
      strategy: new RalphContinuationStrategy(),
      runner,
    });
    const r = await c.runUntilDone('goal');
    expect(r.stopReason).toBe('runner_failed');
  });

  it('stops on max_runs', async () => {
    let calls = 0;
    const runner = async (): Promise<RunHandle> => ({
      runId: `r${++calls}`,
      done: true,
      turns: [],
      fidelity: {
        fidelity: 0.1,
        fidelityTarget: 1,
        pGate: 0.4,
        pGateUsage: 0.4,
        compactionTriggered: true,
      },
    });
    const c = new ContinuationCoordinator({
      strategy: new RalphContinuationStrategy(),
      runner,
      maxRuns: 3,
    });
    const r = await c.runUntilDone('goal');
    expect(r.stopReason).toBe('max_runs');
    expect(r.totalRuns).toBe(3);
  });
});
