import { describe, it, expect, beforeEach } from 'vitest';
import {
  runScenario,
  runEvalSuite,
  runPolicyScenarioWithRules,
  policyPassthroughScenario,
  policyFinalAnswerPassScenario,
  contextNoBudgetPressureScenario,
  contextTruncationScenario,
  contextPriorityOrderingScenario,
  circuitBreakerStaysClosedScenario,
  circuitBreakerOpensScenario,
  circuitBreakerResetOnSuccessScenario,
  memoryWriteSearchScenario,
  memoryEmptyBaselineScenario,
  injectionDetectionScenario,
  injectionCleanPassScenario,
  budgetCeilingBlockScenario,
  handoffAllowedScenario,
  handoffBlockedScenario,
  handoffAllowlistScenario,
  allBuiltInScenarios,
} from '../src/evals';
import type {
  PolicyScenario,
  ContextScenario,
  TransportScenario,
  MemoryScenario,
  HandoffScenario,
  EvalScenario,
} from '../src/evals';
import type { PolicyRule, PolicyContext } from '../src/policy/PolicyEngine';

// ══════════════════════════════════════════════════════════════════════════════
// Policy Scenarios
// ══════════════════════════════════════════════════════════════════════════════

describe('Eval: Policy', () => {
  it('passthrough — no rules yields pass verdict', async () => {
    const scenario = policyPassthroughScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
    expect(result.assertions.every((a) => a.passed)).toBe(true);
  });

  it('final answer passes empty engine', async () => {
    const scenario = policyFinalAnswerPassScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });

  it('runPolicyScenarioWithRules — custom rule blocks proposal', async () => {
    const blockRule: PolicyRule = {
      id: 'block-all',
      name: 'Block All',
      description: 'Blocks every proposal',
      priority: 100,
      evaluate: async (_ctx: PolicyContext) => ({
        ruleId: 'block-all',
        ruleName: 'Block All',
        passed: false,
        verdict: 'block',
        reason: 'All proposals are blocked',
        riskContribution: 100,
      }),
    };

    const scenario: PolicyScenario = {
      ...policyPassthroughScenario(),
      id: 'policy-block-all',
      name: 'Custom rule blocks all',
      expected: {
        verdict: 'block',
        triggeredRuleIds: ['block-all'],
      },
    };

    const result = await runPolicyScenarioWithRules(scenario, [blockRule]);
    expect(result.status).toBe('passed');
    expect(result.assertions.length).toBeGreaterThanOrEqual(2);
  });

  it('runPolicyScenarioWithRules — passing rule matches', async () => {
    const passRule: PolicyRule = {
      id: 'pass-all',
      name: 'Pass All',
      description: 'Passes every proposal',
      priority: 100,
      evaluate: async () => ({
        ruleId: 'pass-all',
        ruleName: 'Pass All',
        passed: true,
        verdict: 'pass',
        reason: 'Approved',
        riskContribution: 0,
      }),
    };

    const scenario: PolicyScenario = {
      ...policyPassthroughScenario(),
      id: 'policy-pass-with-rule',
      name: 'Custom pass rule',
      expected: {
        verdict: 'pass',
        passedRuleIds: ['pass-all'],
      },
    };

    const result = await runPolicyScenarioWithRules(scenario, [passRule]);
    expect(result.status).toBe('passed');
  });

  it('policy scenario preserves category', async () => {
    const scenario = policyPassthroughScenario();
    const result = await runScenario(scenario);
    expect(result.category).toBe('policy');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Context Scenarios
// ══════════════════════════════════════════════════════════════════════════════

describe('Eval: Context', () => {
  it('no budget pressure — all sections included, no truncation', async () => {
    const scenario = contextNoBudgetPressureScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
    expect(result.assertions.every((a) => a.passed)).toBe(true);
  });

  it('truncation — tight budget causes truncation', async () => {
    const scenario = contextTruncationScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
    // Verify the hadTruncation assertion passed
    const truncAssert = result.assertions.find((a) => a.label === 'hadTruncation');
    expect(truncAssert?.passed).toBe(true);
  });

  it('priority ordering — high priority first', async () => {
    const scenario = contextPriorityOrderingScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });

  it('custom context scenario — excludes overflow section', async () => {
    const scenario: ContextScenario = {
      id: 'context-custom-exclude',
      name: 'Overflow section excluded',
      description: 'Very low priority section should be excluded under pressure.',
      category: 'context',
      sections: [
        { source: 'system', content: 'S'.repeat(200), priority: 100 },
        { source: 'custom', content: 'C'.repeat(2000), priority: 1 },
      ],
      maxTokens: 100,
      expected: {
        hadTruncation: true,
        includedSources: ['system'],
      },
    };
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Transport / Circuit Breaker Scenarios
// ══════════════════════════════════════════════════════════════════════════════

describe('Eval: Transport', () => {
  it('stays closed with all successes', async () => {
    const scenario = circuitBreakerStaysClosedScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
    expect(result.assertions.every((a) => a.passed)).toBe(true);
  });

  it('opens after consecutive failures', async () => {
    const scenario = circuitBreakerOpensScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });

  it('success resets failure count', async () => {
    const scenario = circuitBreakerResetOnSuccessScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });

  it('custom scenario — single failure does not trip', async () => {
    const scenario: TransportScenario = {
      id: 'transport-single-fail',
      name: 'Single failure stays closed',
      description: 'One failure should not trip the breaker.',
      category: 'transport',
      callSequence: [{ success: false }],
      config: { failureThreshold: 3 },
      expected: {
        finalSuccess: true,
        circuitState: 'closed',
        totalAttempts: 1,
      },
    };
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Memory Scenarios
// ══════════════════════════════════════════════════════════════════════════════

describe('Eval: Memory', () => {
  it('write and search entries', async () => {
    const scenario = memoryWriteSearchScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });

  it('empty memory baseline — zero results', async () => {
    const scenario = memoryEmptyBaselineScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });

  it('custom scenario — multiple writes accumulate', async () => {
    const scenario: MemoryScenario = {
      id: 'memory-accumulate',
      name: 'Multiple writes accumulate',
      description: 'Writes should accumulate without replacing.',
      category: 'memory',
      seedEntries: [],
      operations: [
        { type: 'write', content: 'Entry 1', kind: 'note', tags: ['t'] },
        { type: 'write', content: 'Entry 2', kind: 'note', tags: ['t'] },
        { type: 'write', content: 'Entry 3', kind: 'note', tags: ['t'] },
      ],
      expected: { totalEntries: 3 },
    };
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Security Scenarios
// ══════════════════════════════════════════════════════════════════════════════

describe('Eval: Security', () => {
  it('injection detection catches imperative override', async () => {
    const scenario = injectionDetectionScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });

  it('clean proposal passes injection detection', async () => {
    const scenario = injectionCleanPassScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });

  it('budget ceiling with no context overspend passes', async () => {
    const scenario = budgetCeilingBlockScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Handoff Scenarios
// ══════════════════════════════════════════════════════════════════════════════

describe('Eval: Handoff', () => {
  it('no restrictions → handoff allowed', async () => {
    const scenario = handoffAllowedScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });

  it('blocked target → handoff blocked', async () => {
    const scenario = handoffBlockedScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });

  it('allowlist target → handoff allowed', async () => {
    const scenario = handoffAllowlistScenario();
    const result = await runScenario(scenario);
    expect(result.status).toBe('passed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Suite Runner
// ══════════════════════════════════════════════════════════════════════════════

describe('Eval: Suite Runner', () => {
  it('runEvalSuite aggregates results from all built-in scenarios', async () => {
    const scenarios = allBuiltInScenarios();
    const suite = await runEvalSuite('suite-1', 'Built-in Regression', scenarios);

    expect(suite.suiteId).toBe('suite-1');
    expect(suite.suiteName).toBe('Built-in Regression');
    expect(suite.total).toBe(scenarios.length);
    expect(suite.passed + suite.failed + suite.errored + suite.skipped).toBe(suite.total);
    expect(suite.durationMs).toBeGreaterThanOrEqual(0);
    expect(suite.completedAt).toBeGreaterThan(0);
    expect(suite.results).toHaveLength(scenarios.length);
  });

  it('suite status is passed when all pass', async () => {
    // Use only baseline scenarios that are guaranteed to pass
    const scenarios: EvalScenario[] = [
      policyPassthroughScenario(),
      policyFinalAnswerPassScenario(),
      contextNoBudgetPressureScenario(),
    ];
    const suite = await runEvalSuite('suite-2', 'Passing only', scenarios);
    expect(suite.status).toBe('passed');
    expect(suite.passed).toBe(3);
    expect(suite.failed).toBe(0);
  });

  it('suite status is failed when any scenario fails', async () => {
    // Create a deliberately failing scenario
    const failing: PolicyScenario = {
      id: 'deliberate-fail',
      name: 'Expect block but gets pass',
      description: 'This scenario expects block which will fail on an empty engine.',
      category: 'policy',
      proposal: { type: 'final_answer', answer: 'Hi' },
      context: {},
      expected: { verdict: 'block' }, // Will fail: empty engine returns pass
    };
    const suite = await runEvalSuite('suite-3', 'Has failure', [failing]);
    expect(suite.status).toBe('failed');
    expect(suite.failed).toBe(1);
  });

  it('suite captures errored scenarios', async () => {
    // Create scenario that references a category we don't handle
    const bad = {
      id: 'bad-scenario',
      name: 'Bad',
      description: 'Invalid',
      category: 'orchestration' as const,
      tags: [],
    } as unknown as EvalScenario;

    const suite = await runEvalSuite('suite-4', 'Error suite', [bad]);
    // Orchestration is handled by default → skipped
    expect(suite.results[0].status).toBe('skipped');
    expect(suite.skipped).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario Result Structure
// ══════════════════════════════════════════════════════════════════════════════

describe('Eval: Result Structure', () => {
  it('result includes scenarioId, name, category, status, durationMs', async () => {
    const scenario = policyPassthroughScenario();
    const result = await runScenario(scenario);

    expect(result.scenarioId).toBe('policy-passthrough');
    expect(result.scenarioName).toBe('No rules → pass verdict');
    expect(result.category).toBe('policy');
    expect(result.status).toBe('passed');
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('assertions have label, passed, expected, actual', async () => {
    const scenario = policyPassthroughScenario();
    const result = await runScenario(scenario);

    for (const assertion of result.assertions) {
      expect(assertion).toHaveProperty('label');
      expect(assertion).toHaveProperty('passed');
      expect(assertion).toHaveProperty('expected');
      expect(assertion).toHaveProperty('actual');
    }
  });

  it('failed scenario has failing assertions', async () => {
    const failing: PolicyScenario = {
      id: 'fail-structure',
      name: 'Fail for structure test',
      description: 'Should fail',
      category: 'policy',
      proposal: { type: 'final_answer', answer: 'ok' },
      context: {},
      expected: { verdict: 'block' },
    };
    const result = await runScenario(failing);
    expect(result.status).toBe('failed');
    expect(result.assertions.some((a) => !a.passed)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario Factories
// ══════════════════════════════════════════════════════════════════════════════

describe('Eval: Scenario Factories', () => {
  it('allBuiltInScenarios returns at least 10 scenarios', () => {
    const all = allBuiltInScenarios();
    expect(all.length).toBeGreaterThanOrEqual(10);
  });

  it('each built-in scenario has a unique id', () => {
    const all = allBuiltInScenarios();
    const ids = all.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('policyPassthroughScenario accepts overrides', () => {
    const custom = policyPassthroughScenario({
      id: 'custom-passthrough',
      name: 'Custom passthrough',
    });
    expect(custom.id).toBe('custom-passthrough');
    expect(custom.category).toBe('policy');
  });

  it('scenarios cover all categories', () => {
    const all = allBuiltInScenarios();
    const categories = new Set(all.map((s) => s.category));
    expect(categories.has('policy')).toBe(true);
    expect(categories.has('context')).toBe(true);
    expect(categories.has('transport')).toBe(true);
    expect(categories.has('memory')).toBe(true);
    expect(categories.has('security')).toBe(true);
    expect(categories.has('handoff')).toBe(true);
  });
});
