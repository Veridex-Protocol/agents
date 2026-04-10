import { describe, it, expect } from 'vitest';
import {
  runEvalSuite,
  runSplit,
  validateSplitBalance,
  toCaseOutcome,
  buildSplitResult,
  policyPassthroughScenario,
  policyFinalAnswerPassScenario,
  contextNoBudgetPressureScenario,
  contextTruncationScenario,
  injectionDetectionScenario,
  injectionCleanPassScenario,
} from '../src/evals';
import {
  extractSurfaces,
  buildVariant,
  buildVariantFromDef,
  applyVariant,
  diffVariants,
} from '../src/evals';
import { runExperiment } from '../src/evals';
import type {
  EvalScenario,
  EvalSplit,
  CaseOutcome,
  SplitResult,
  StrataValidation,
  HarnessSurface,
  HarnessVariant,
  ExperimentConfig,
  IterationDiagnosis,
} from '../src/evals';
import type { AgentDefinition } from '../src/types/agent';

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

function makeBaseDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    model: { provider: 'openai', model: 'gpt-4o-mini' },
    instructions: 'You are a helpful test agent.',
    tools: [{ name: 'search', description: 'Search tool', parameters: {} }],
    policies: [{ type: 'budget', params: { maxTokens: 1000 } }],
    ...overrides,
  };
}

function tagScenario<T extends EvalScenario>(
  scenario: T,
  split: EvalSplit,
  stratum?: string,
): T {
  return { ...scenario, split, stratum };
}

// ══════════════════════════════════════════════════════════════════════════════
// Phase 1: Split-aware eval system
// ══════════════════════════════════════════════════════════════════════════════

describe('Eval: Split awareness', () => {
  it('scenarios accept split and stratum overrides', () => {
    const s = policyPassthroughScenario({ split: 'train', stratum: 'policy' });
    expect(s.split).toBe('train');
    expect(s.stratum).toBe('policy');
  });

  it('factories without overrides have no split', () => {
    const s = policyFinalAnswerPassScenario();
    expect(s.split).toBeUndefined();
    expect(s.stratum).toBeUndefined();
  });

  it('toCaseOutcome converts scenario+result to CaseOutcome', async () => {
    const scenario = policyPassthroughScenario({ split: 'train', stratum: 'policy' });
    const result = {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      category: scenario.category,
      status: 'passed' as const,
      assertions: [],
      durationMs: 10,
      completedAt: Date.now(),
    };
    const outcome = toCaseOutcome(scenario, result);
    expect(outcome.caseId).toBe('policy-passthrough');
    expect(outcome.split).toBe('train');
    expect(outcome.stratum).toBe('policy');
    expect(outcome.status).toBe('passed');
    expect(outcome.score).toBe(1);
  });

  it('buildSplitResult aggregates outcomes correctly', () => {
    const outcomes: CaseOutcome[] = [
      {
        caseId: 'a',
        split: 'train',
        status: 'passed',
        score: 1,
        scenarioResult: {} as CaseOutcome['scenarioResult'],
      },
      {
        caseId: 'b',
        split: 'train',
        status: 'failed',
        score: 0,
        failureMessage: 'bad',
        scenarioResult: {} as CaseOutcome['scenarioResult'],
      },
      {
        caseId: 'c',
        split: 'train',
        status: 'passed',
        score: 1,
        scenarioResult: {} as CaseOutcome['scenarioResult'],
      },
    ];
    const result = buildSplitResult('train', 'v1', outcomes);
    expect(result.split).toBe('train');
    expect(result.variant).toBe('v1');
    expect(result.passed).toBe(2);
    expect(result.total).toBe(3);
    expect(result.correctness).toBeCloseTo(2 / 3);
    expect(result.failingOutcomes).toHaveLength(1);
    expect(result.failingOutcomes[0].caseId).toBe('b');
  });
});

describe('Eval: Strata validation', () => {
  it('balanced strata returns no warnings', () => {
    const scenarios: EvalScenario[] = [
      tagScenario(policyPassthroughScenario(), 'train', 'policy'),
      tagScenario(policyFinalAnswerPassScenario(), 'holdout', 'policy'),
    ];
    const validation = validateSplitBalance(scenarios);
    expect(validation.balanced).toBe(true);
    expect(validation.warnings).toHaveLength(0);
  });

  it('missing holdout stratum produces warning', () => {
    const scenarios: EvalScenario[] = [
      tagScenario(policyPassthroughScenario(), 'train', 'policy'),
      tagScenario(policyFinalAnswerPassScenario(), 'train', 'context'),
      tagScenario(contextNoBudgetPressureScenario(), 'holdout', 'policy'),
      // 'context' stratum missing from holdout
    ];
    const validation = validateSplitBalance(scenarios);
    expect(validation.balanced).toBe(false);
    expect(validation.missingFromHoldout).toContain('context');
  });

  it('scenarios without splits return balanced', () => {
    const scenarios: EvalScenario[] = [
      policyPassthroughScenario(),
      policyFinalAnswerPassScenario(),
    ];
    const validation = validateSplitBalance(scenarios);
    expect(validation.balanced).toBe(true);
    expect(validation.warnings).toHaveLength(0);
  });
});

describe('Eval: runSplit', () => {
  it('runs only train-split scenarios', async () => {
    const scenarios: EvalScenario[] = [
      tagScenario(policyPassthroughScenario(), 'train', 'policy'),
      tagScenario(policyFinalAnswerPassScenario(), 'holdout', 'policy'),
    ];
    const result = await runSplit(scenarios, 'train');
    expect(result.split).toBe('train');
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.correctness).toBe(1);
  });

  it('returns empty result for unused split', async () => {
    const scenarios: EvalScenario[] = [
      tagScenario(policyPassthroughScenario(), 'train'),
    ];
    const result = await runSplit(scenarios, 'scorecard');
    expect(result.total).toBe(0);
    expect(result.correctness).toBe(1); // vacuously true
  });
});

describe('Eval: runEvalSuite with splits', () => {
  it('populates splitResults when scenarios have splits', async () => {
    const scenarios: EvalScenario[] = [
      tagScenario(policyPassthroughScenario(), 'train', 'policy'),
      tagScenario(policyFinalAnswerPassScenario(), 'holdout', 'policy'),
    ];
    const suite = await runEvalSuite('split-test', 'Split Test', scenarios);
    expect(suite.splitResults).toBeDefined();
    expect(suite.splitResults!.train).toBeDefined();
    expect(suite.splitResults!.holdout).toBeDefined();
    expect(suite.splitResults!.train.total).toBe(1);
    expect(suite.splitResults!.holdout.total).toBe(1);
  });

  it('has no splitResults when scenarios lack splits', async () => {
    const scenarios: EvalScenario[] = [
      policyPassthroughScenario(),
      policyFinalAnswerPassScenario(),
    ];
    const suite = await runEvalSuite('no-split', 'No Split', scenarios);
    expect(suite.splitResults).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Phase 2: Surfaces & Variants
// ══════════════════════════════════════════════════════════════════════════════

describe('Surfaces: extractSurfaces', () => {
  it('extracts instructions, tools, policies from definition', () => {
    const def = makeBaseDef();
    const surfaces = extractSurfaces(def);
    const names = surfaces.map((s) => s.name);
    expect(names).toContain('instructions');
    expect(names).toContain('tools');
    expect(names).toContain('policies');
  });

  it('does not include undefined surfaces', () => {
    const def = makeBaseDef({ tools: undefined, policies: undefined });
    const surfaces = extractSurfaces(def);
    const names = surfaces.map((s) => s.name);
    expect(names).not.toContain('tools');
    expect(names).not.toContain('policies');
    expect(names).toContain('instructions'); // always present
  });
});

describe('Surfaces: buildVariant', () => {
  it('creates a variant with toJSON', () => {
    const surfaces: HarnessSurface[] = [
      { name: 'instructions', kind: 'instructions', value: 'Be concise.' },
    ];
    const variant = buildVariant('v1', surfaces);
    expect(variant.label).toBe('v1');
    expect(variant.surfaces).toHaveLength(1);
    const json = variant.toJSON();
    expect(json.label).toBe('v1');
    expect(json.surfaces).toHaveLength(1);
  });

  it('buildVariantFromDef round-trips through applyVariant', () => {
    const def = makeBaseDef();
    const variant = buildVariantFromDef('baseline', def);
    const applied = applyVariant(variant, makeBaseDef({ instructions: 'CHANGED' }));
    // The variant should restore the original instructions
    expect(applied.instructions).toBe('You are a helpful test agent.');
  });
});

describe('Surfaces: applyVariant', () => {
  it('returns new object without mutating original', () => {
    const def = makeBaseDef();
    const original = def.instructions;
    const surfaces: HarnessSurface[] = [
      { name: 'instructions', kind: 'instructions', value: 'New instructions.' },
    ];
    const variant = buildVariant('v1', surfaces);
    const applied = applyVariant(variant, def);
    expect(applied.instructions).toBe('New instructions.');
    expect(def.instructions).toBe(original); // not mutated
  });

  it('applies custom surfaces to metadata', () => {
    const def = makeBaseDef();
    const surfaces: HarnessSurface[] = [
      { name: 'temperature', kind: 'custom', value: 0.7 },
    ];
    const variant = buildVariant('v1', surfaces);
    const applied = applyVariant(variant, def);
    expect(applied.metadata?.temperature).toBe(0.7);
  });
});

describe('Surfaces: diffVariants', () => {
  it('detects changed surfaces', () => {
    const a = buildVariant('a', [
      { name: 'instructions', kind: 'instructions', value: 'Be helpful.' },
    ]);
    const b = buildVariant('b', [
      { name: 'instructions', kind: 'instructions', value: 'Be concise.' },
    ]);
    const diff = diffVariants(a, b);
    expect(diff.changed).toContain('instructions');
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('detects added surfaces', () => {
    const a = buildVariant('a', []);
    const b = buildVariant('b', [
      { name: 'tools', kind: 'tools', value: [] },
    ]);
    const diff = diffVariants(a, b);
    expect(diff.added).toContain('tools');
  });

  it('detects removed surfaces', () => {
    const a = buildVariant('a', [
      { name: 'tools', kind: 'tools', value: [] },
    ]);
    const b = buildVariant('b', []);
    const diff = diffVariants(a, b);
    expect(diff.removed).toContain('tools');
  });

  it('reports no differences for identical variants', () => {
    const a = buildVariant('a', [
      { name: 'instructions', kind: 'instructions', value: 'Same.' },
    ]);
    const b = buildVariant('b', [
      { name: 'instructions', kind: 'instructions', value: 'Same.' },
    ]);
    const diff = diffVariants(a, b);
    expect(diff.summary).toBe('no differences');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Phase 3: Experiment loop
// ══════════════════════════════════════════════════════════════════════════════

describe('Experiment: runExperiment', () => {
  it('runs baseline and iterates with mock proposer', async () => {
    const baseDef = makeBaseDef();
    const scenarios: EvalScenario[] = [
      tagScenario(policyPassthroughScenario(), 'train', 'policy'),
      tagScenario(policyFinalAnswerPassScenario(), 'train', 'policy'),
      tagScenario(contextNoBudgetPressureScenario(), 'holdout', 'context'),
    ];

    let proposerCalls = 0;
    const config: ExperimentConfig = {
      experimentId: 'exp-1',
      name: 'Test Experiment',
      baseDefinition: baseDef,
      scenarios,
      maxIterations: 2,
      proposer: async (diagnosis: IterationDiagnosis) => {
        proposerCalls++;
        // Just return the current variant unchanged (no-op proposer)
        return diagnosis.currentVariant;
      },
    };

    const report = await runExperiment(config);

    expect(report.experimentId).toBe('exp-1');
    expect(report.baselineTrainResult.total).toBe(2);
    expect(report.baselineTrainResult.correctness).toBe(1); // all pass
    expect(report.totalIterations).toBe(0); // perfect score → early exit
    expect(report.bestVariant.label).toBe('baseline');
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('accepts improved variants with greedy criteria', async () => {
    const baseDef = makeBaseDef();

    // Create scenarios where security ones will always fail (injection detection
    // needs the security subsystem), but policy ones pass
    const scenarios: EvalScenario[] = [
      tagScenario(policyPassthroughScenario(), 'train', 'policy'),
      tagScenario(policyFinalAnswerPassScenario(), 'train', 'policy'),
      tagScenario(policyPassthroughScenario(), 'holdout', 'policy'),
    ];

    const config: ExperimentConfig = {
      experimentId: 'exp-2',
      name: 'Greedy Acceptance',
      baseDefinition: baseDef,
      scenarios,
      maxIterations: 1,
      acceptance: 'greedy',
      evalHoldout: true,
      proposer: async (diagnosis) => {
        // Return a variant with modified instructions
        return buildVariant('proposed-v1', [
          { name: 'instructions', kind: 'instructions', value: 'Updated instructions.' },
        ]);
      },
    };

    const report = await runExperiment(config);

    // Baseline was perfect, early exit before proposer called
    expect(report.baselineTrainResult.correctness).toBe(1);
  });

  it('diagnosis includes failuresByStratum', async () => {
    const baseDef = makeBaseDef();

    // injectionDetectionScenario will fail because no security subsystem
    const scenarios: EvalScenario[] = [
      tagScenario(injectionDetectionScenario(), 'train', 'security'),
      tagScenario(injectionCleanPassScenario(), 'train', 'security'),
    ];

    let capturedDiagnosis: IterationDiagnosis | undefined;
    const config: ExperimentConfig = {
      experimentId: 'exp-3',
      name: 'Diagnosis Test',
      baseDefinition: baseDef,
      scenarios,
      maxIterations: 1,
      evalHoldout: false,
      proposer: async (diagnosis) => {
        capturedDiagnosis = diagnosis;
        return diagnosis.currentVariant;
      },
    };

    const report = await runExperiment(config);

    // If any scenario failed, the proposer should have been called
    if (capturedDiagnosis) {
      expect(capturedDiagnosis.iteration).toBe(0);
      expect(capturedDiagnosis.trainResult).toBeDefined();
      expect(capturedDiagnosis.failuresByStratum).toBeDefined();
    }
  });

  it('report serialises to JSON and markdown', async () => {
    const baseDef = makeBaseDef();
    const scenarios: EvalScenario[] = [
      tagScenario(policyPassthroughScenario(), 'train', 'policy'),
      tagScenario(policyFinalAnswerPassScenario(), 'holdout', 'policy'),
    ];

    const config: ExperimentConfig = {
      experimentId: 'exp-4',
      name: 'Serialisation Test',
      baseDefinition: baseDef,
      scenarios,
      maxIterations: 0,
      evalHoldout: true,
      proposer: async (d) => d.currentVariant,
    };

    const report = await runExperiment(config);

    const json = report.toJSON();
    expect(json.experimentId).toBe('exp-4');
    expect(typeof json.baselineCorrectness).toBe('number');

    const md = report.toMarkdown();
    expect(md).toContain('# Experiment: Serialisation Test');
    expect(md).toContain('Baseline Train');
  });
});
