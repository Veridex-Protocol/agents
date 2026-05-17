import { describe, it, expect, vi } from 'vitest';
import { HomeostaticContextEngine } from '../src/context/HomeostaticContextEngine';
import { LinearFidelityModel } from '../src/context/FidelityModel';
import type { ContextSectionInput } from '../src/types/context';

function sectionOfTokens(id: string, tokens: number, priority = 50): ContextSectionInput {
  // ContextCompiler estimates tokens as ceil(chars/4). Pad content to hit target.
  return {
    id,
    source: 'memory',
    content: 'a'.repeat(tokens * 4),
    priority,
  };
}

describe('HomeostaticContextEngine', () => {
  it('attaches a fidelity report to every compile', () => {
    const engine = new HomeostaticContextEngine({ degradation: 0.4, fidelityTarget: 0.8 });
    const plan = engine.compile({
      maxTokens: 100_000,
      sections: [sectionOfTokens('s1', 10_000)],
    });

    expect(plan.fidelityReport).toBeDefined();
    expect(plan.fidelityReport.promptTokens).toBe(10_000);
    expect(plan.fidelityReport.fidelity).toBeCloseTo(0.96, 6);
    expect(plan.fidelityReport.fidelityTarget).toBe(0.8);
    // pGate(0.8) with D=0.4 → 50k
    expect(plan.fidelityReport.pGate).toBeCloseTo(50_000, 6);
    expect(plan.fidelityReport.pGateUsage).toBeCloseTo(0.2, 6);
  });

  it('does not trigger compaction when well under threshold', () => {
    const onFidelityReport = vi.fn();
    const onCompactionRequired = vi.fn();
    const engine = new HomeostaticContextEngine({
      degradation: 0.4,
      fidelityTarget: 0.8,
      compactionThreshold: 0.5,
      onFidelityReport,
      onCompactionRequired,
    });

    const plan = engine.compile({
      maxTokens: 100_000,
      sections: [sectionOfTokens('s1', 10_000)],
    });

    expect(plan.compactionTriggered).toBe(false);
    expect(plan.fidelityReport.reasons).toEqual([]);
    expect(onFidelityReport).toHaveBeenCalledOnce();
    expect(onCompactionRequired).not.toHaveBeenCalled();
  });

  it('fires approaching_pgate at >= compactionThreshold · pGate', () => {
    const onCompactionRequired = vi.fn();
    const engine = new HomeostaticContextEngine({
      degradation: 0.4,
      fidelityTarget: 0.8, // pGate = 50k
      compactionThreshold: 0.5, // trigger ≥ 25k
      onCompactionRequired,
    });

    const plan = engine.compile({
      maxTokens: 100_000,
      sections: [sectionOfTokens('s1', 25_000)],
    });

    expect(plan.compactionTriggered).toBe(true);
    expect(plan.fidelityReport.reasons).toContain('approaching_pgate');
    expect(onCompactionRequired).toHaveBeenCalledOnce();
    expect(onCompactionRequired.mock.calls[0][0].plan).toBe(plan);
  });

  it('fires fidelity_below_target when underwater', () => {
    const engine = new HomeostaticContextEngine({
      degradation: 0.4,
      fidelityTarget: 0.8, // F<0.8 once P>50k
    });

    const plan = engine.compile({
      maxTokens: 200_000,
      sections: [sectionOfTokens('s1', 60_000)],
    });

    expect(plan.compactionTriggered).toBe(true);
    expect(plan.fidelityReport.reasons).toContain('fidelity_below_target');
    // approaching_pgate also fires since 60k > 25k
    expect(plan.fidelityReport.reasons).toContain('approaching_pgate');
  });

  it('flags truncation_observed when compiler truncates', () => {
    const engine = new HomeostaticContextEngine({ degradation: 0.4 });
    const plan = engine.compile({
      maxTokens: 100, // tiny
      sections: [sectionOfTokens('s1', 5_000)],
    });
    expect(plan.fidelityReport.reasons).toContain('truncation_observed');
    expect(plan.compactionTriggered).toBe(true);
  });

  it('respects an explicit fidelity model', () => {
    const model = new LinearFidelityModel(0.1, 'custom');
    const engine = new HomeostaticContextEngine({ fidelityModel: model });
    expect(engine.fidelityModel).toBe(model);
    expect(engine.fidelityModel.id).toBe('custom');
  });

  it('rejects invalid target or threshold', () => {
    expect(() => new HomeostaticContextEngine({ fidelityTarget: 0 })).toThrow();
    expect(() => new HomeostaticContextEngine({ fidelityTarget: 1 })).toThrow();
    expect(() => new HomeostaticContextEngine({ compactionThreshold: 0 })).toThrow();
    expect(() => new HomeostaticContextEngine({ compactionThreshold: 1.1 })).toThrow();
  });

  it('evaluate() reports fidelity for an externally compiled plan', () => {
    const engine = new HomeostaticContextEngine({
      degradation: 0.4,
      fidelityTarget: 0.8,
    });
    const plan = engine.compiler.compile({
      maxTokens: 100_000,
      sections: [sectionOfTokens('s1', 30_000)],
    });
    const report = engine.evaluate(plan);
    expect(report.promptTokens).toBe(30_000);
    expect(report.reasons).toContain('approaching_pgate');
  });

  it('compileWithPolicy routes through the underlying compiler', () => {
    const engine = new HomeostaticContextEngine({ degradation: 0.4 });
    const plan = engine.compileWithPolicy({
      maxTokens: 100_000,
      sections: [
        { id: 'sys', source: 'system', content: 'You are helpful.', priority: 10 },
        sectionOfTokens('m1', 1_000),
      ],
    });
    expect(plan.sections.length).toBe(2);
    expect(plan.fidelityReport).toBeDefined();
    // system is in the policy's preferred group, memory comes after.
    expect(plan.sections[0].source).toBe('system');
  });
});
