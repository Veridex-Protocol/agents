/**
 * @module EvalRunner
 * @description
 * Scenario runner that executes eval scenarios against runtime subsystems
 * and produces structured results for regression tracking.
 */

import type {
  EvalScenario,
  PolicyScenario,
  ContextScenario,
  TransportScenario,
  MemoryScenario,
  SecurityScenario,
  HandoffScenario,
  ScenarioResult,
  ScenarioStatus,
  AssertionResult,
  EvalSuiteResult,
  EvalSplit,
  SplitResult,
  CaseOutcome,
  StrataValidation,
} from './types';
import { PolicyEngine, type PolicyContext, type PolicyRule } from '../policy/PolicyEngine';
import { ContextCompiler } from '../context/ContextCompiler';
import { CircuitBreaker } from '../transports/CircuitBreaker';
import { MemoryManager } from '../memory/MemoryManager';
import { SecurityPolicyPackManager } from '../security/SecurityPolicyPackManager';
import { HookRegistry } from '../hooks/HookRegistry';
import {
  injectionDetectionPack,
  toolPoisoningPack,
  handoffSafetyPack,
  modelRestrictionPack,
  budgetCeilingPack,
  endpointAllowlistPack,
} from '../security/packs';

// ── Assertion Helpers ──

function assert(label: string, expected: unknown, actual: unknown): AssertionResult {
  const eq = JSON.stringify(expected) === JSON.stringify(actual);
  return { label, passed: eq, expected: String(expected), actual: String(actual) };
}

function assertInRange(label: string, value: number, min: number, max: number): AssertionResult {
  const passed = value >= min && value <= max;
  return { label, passed, expected: `[${min}, ${max}]`, actual: String(value) };
}

function assertIncludes(label: string, haystack: string[], needle: string): AssertionResult {
  const passed = haystack.includes(needle);
  return { label, passed, expected: needle, actual: haystack.join(', ') };
}

function assertSubstring(label: string, text: string, substring: string): AssertionResult {
  const passed = text.toLowerCase().includes(substring.toLowerCase());
  return { label, passed, expected: `contains "${substring}"`, actual: text };
}

// ── Scenario Executors ──

async function runPolicyScenario(scenario: PolicyScenario): Promise<AssertionResult[]> {
  const engine = new PolicyEngine();
  const assertions: AssertionResult[] = [];

  // Build policy rules from scenario config
  // The caller should pre-register rules; we test with a fresh engine
  // and the scenario's expected verdict against an empty engine or
  // a scenario-configured engine. For built-in scenarios, rules are
  // provided alongside. We evaluate the proposal.
  const ctx: PolicyContext = {
    runId: scenario.context.runId ?? 'eval-run',
    agentId: scenario.context.agentId ?? 'eval-agent',
    turnIndex: scenario.context.turnIndex ?? 0,
    proposal: scenario.proposal,
    runSpendUSD: scenario.context.runSpendUSD,
    totalTokens: scenario.context.totalTokens,
    metadata: scenario.context.metadata,
  };

  const decision = await engine.evaluate(ctx);

  assertions.push(assert('verdict', scenario.expected.verdict, decision.verdict));

  if (scenario.expected.riskScoreRange) {
    assertions.push(
      assertInRange(
        'riskScore',
        decision.riskScore,
        scenario.expected.riskScoreRange[0],
        scenario.expected.riskScoreRange[1],
      ),
    );
  }

  if (scenario.expected.triggeredRuleIds) {
    const failedIds = decision.checks.filter((c) => !c.passed).map((c) => c.ruleId);
    for (const ruleId of scenario.expected.triggeredRuleIds) {
      assertions.push(assertIncludes(`triggered rule ${ruleId}`, failedIds, ruleId));
    }
  }

  if (scenario.expected.passedRuleIds) {
    const passedIds = decision.checks.filter((c) => c.passed).map((c) => c.ruleId);
    for (const ruleId of scenario.expected.passedRuleIds) {
      assertions.push(assertIncludes(`passed rule ${ruleId}`, passedIds, ruleId));
    }
  }

  return assertions;
}

function runContextScenario(scenario: ContextScenario): AssertionResult[] {
  const compiler = new ContextCompiler();
  const assertions: AssertionResult[] = [];

  const inputs = scenario.sections.map((s, i) => ({
    id: `eval-section-${i}`,
    source: s.source as import('../types/context').ContextSource,
    content: s.content,
    priority: s.priority,
    budgetTokens: s.budgetTokens,
  }));

  const plan = compiler.compile({ maxTokens: scenario.maxTokens, sections: inputs });

  if (scenario.expected.totalTokensRange) {
    assertions.push(
      assertInRange(
        'totalTokens',
        plan.totalTokens,
        scenario.expected.totalTokensRange[0],
        scenario.expected.totalTokensRange[1],
      ),
    );
  }

  assertions.push(assert('hadTruncation', scenario.expected.hadTruncation, plan.hadTruncation));

  const outputSources = plan.sections.filter((s) => s.actualTokens > 0).map((s) => s.source as string);

  for (const src of scenario.expected.includedSources) {
    assertions.push(assertIncludes(`included source: ${src}`, outputSources, src));
  }

  if (scenario.expected.excludedSources) {
    for (const src of scenario.expected.excludedSources) {
      const passed = !outputSources.includes(src);
      assertions.push({
        label: `excluded source: ${src}`,
        passed,
        expected: `not in output`,
        actual: outputSources.join(', '),
      });
    }
  }

  if (scenario.expected.ordered && scenario.expected.includedSources.length > 1) {
    const indices = scenario.expected.includedSources.map((s) => outputSources.indexOf(s));
    const isOrdered = indices.every((v, i) => i === 0 || v >= indices[i - 1]);
    assertions.push({
      label: 'source ordering',
      passed: isOrdered,
      expected: scenario.expected.includedSources.join(' → '),
      actual: outputSources.join(' → '),
    });
  }

  return assertions;
}

function runTransportScenario(scenario: TransportScenario): AssertionResult[] {
  const assertions: AssertionResult[] = [];
  const endpoint = 'eval-endpoint';

  const cb = new CircuitBreaker({
    failureThreshold: scenario.config?.failureThreshold ?? 3,
    resetTimeoutMs: scenario.config?.resetTimeoutMs ?? 100,
    halfOpenMaxProbes: 1,
  });

  let totalAttempts = 0;

  for (const call of scenario.callSequence) {
    const canExec = cb.canExecute(endpoint);
    if (canExec) {
      totalAttempts++;
      if (call.success) {
        cb.recordSuccess(endpoint);
      } else {
        cb.recordFailure(endpoint);
      }
    }
  }

  const finalState = cb.getState(endpoint);

  if (scenario.expected.circuitState) {
    assertions.push(assert('circuitState', scenario.expected.circuitState, finalState));
  }

  if (scenario.expected.totalAttempts !== undefined) {
    assertions.push(assert('totalAttempts', scenario.expected.totalAttempts, totalAttempts));
  }

  // Final success: check if circuit allows one more call
  const finalCanExecute = cb.canExecute(endpoint);
  assertions.push(assert('finalSuccess', scenario.expected.finalSuccess, finalCanExecute));

  return assertions;
}

async function runMemoryScenario(scenario: MemoryScenario): Promise<AssertionResult[]> {
  const manager = new MemoryManager();
  const assertions: AssertionResult[] = [];

  // Seed entries
  for (const seed of scenario.seedEntries) {
    await manager.write({
      entry: {
        content: seed.content,
        tier: 'semantic',
        scope: 'agent',
        provenance: 'system',
        confidence: 1,
        ttlMs: 0,
        tags: seed.tags ?? [],
        kind: (seed.kind as 'note' | 'workspace_state' | 'derived_memory' | 'evidence') ?? 'note',
        metadata: seed.metadata,
      },
      overwriteStrategy: 'skip',
    });
  }

  // Execute operations
  for (const op of scenario.operations) {
    if (op.type === 'write') {
      await manager.write({
        entry: {
          content: op.content,
          tier: 'semantic',
          scope: 'agent',
          provenance: 'agent',
          confidence: 1,
          ttlMs: 0,
          tags: op.tags ?? [],
          kind: (op.kind as 'note' | 'workspace_state' | 'derived_memory' | 'evidence') ?? 'note',
        },
        overwriteStrategy: 'skip',
      });
    } else if (op.type === 'search') {
      const results = await manager.search({ text: op.query });
      assertions.push(
        assertInRange(
          `search "${op.query}" results`,
          results.length,
          op.expectedMinResults,
          op.expectedMaxResults ?? Infinity,
        ),
      );
    } else if (op.type === 'read') {
      const results = await manager.search({ tags: [op.tag] });
      assertions.push(assert(`read tag "${op.tag}" count`, op.expectedCount, results.length));
    }
  }

  // Check final entry count
  const all = await manager.search({});
  assertions.push(assert('totalEntries', scenario.expected.totalEntries, all.length));

  return assertions;
}

async function runSecurityScenario(scenario: SecurityScenario): Promise<AssertionResult[]> {
  const assertions: AssertionResult[] = [];
  const engine = new PolicyEngine();
  const hooks = new HookRegistry();
  const manager = new SecurityPolicyPackManager(engine, hooks);

  // Create and register the appropriate pack
  const cfg = scenario.packConfig;
  let pack;
  switch (scenario.packType) {
    case 'injection':
      pack = injectionDetectionPack(cfg as Parameters<typeof injectionDetectionPack>[0]);
      break;
    case 'tool_poisoning':
      pack = toolPoisoningPack(cfg as Parameters<typeof toolPoisoningPack>[0]);
      break;
    case 'handoff_safety':
      pack = handoffSafetyPack(cfg as Parameters<typeof handoffSafetyPack>[0]);
      break;
    case 'model_restriction':
      pack = modelRestrictionPack(cfg as Parameters<typeof modelRestrictionPack>[0]);
      break;
    case 'budget_ceiling':
      pack = budgetCeilingPack(cfg as Parameters<typeof budgetCeilingPack>[0]);
      break;
    case 'endpoint_allowlist':
      pack = endpointAllowlistPack(cfg as unknown as Parameters<typeof endpointAllowlistPack>[0]);
      break;
  }

  manager.registerPack(pack);

  // If testing via policy evaluation
  if (scenario.input.proposal) {
    const ctx: PolicyContext = {
      runId: 'eval-run',
      agentId: 'eval-agent',
      turnIndex: 0,
      proposal: scenario.input.proposal,
      metadata: scenario.input.hookContext,
    };
    const decision = await engine.evaluate(ctx);

    if (scenario.expected.verdict) {
      assertions.push(assert('verdict', scenario.expected.verdict, decision.verdict));
    }

    const wasBlocked = decision.verdict === 'block' || decision.verdict === 'escalate';
    assertions.push(assert('shouldBlock', scenario.expected.shouldBlock, wasBlocked));

    if (scenario.expected.triggerReasons) {
      const allReasons = decision.reasons.join(' ');
      for (const reason of scenario.expected.triggerReasons) {
        assertions.push(assertSubstring(`trigger reason "${reason}"`, allReasons, reason));
      }
    }
  }

  return assertions;
}

async function runHandoffScenario(scenario: HandoffScenario): Promise<AssertionResult[]> {
  const assertions: AssertionResult[] = [];
  const engine = new PolicyEngine();
  const hooks = new HookRegistry();
  const manager = new SecurityPolicyPackManager(engine, hooks);

  if (scenario.config?.allowList || scenario.config?.blockList) {
    const pack = handoffSafetyPack({
      allowedTargets: scenario.config.allowList,
      blockedTargets: scenario.config.blockList,
      requireApproval: scenario.config.requireApproval,
    });
    manager.registerPack(pack);
  }

  const ctx: PolicyContext = {
    runId: 'eval-run',
    agentId: scenario.sourceAgentId,
    turnIndex: 0,
    proposal: {
      type: 'handoff',
      targetAgentId: scenario.targetAgentId,
      reason: scenario.reason,
    },
  };

  const decision = await engine.evaluate(ctx);

  const isAllowed = decision.verdict === 'pass' || decision.verdict === 'flag';
  assertions.push(assert('handoff allowed', scenario.expected.allowed, isAllowed));

  if (scenario.expected.verdict) {
    assertions.push(assert('verdict', scenario.expected.verdict, decision.verdict));
  }

  return assertions;
}

// ── Main Runner ──

async function executeScenario(scenario: EvalScenario): Promise<ScenarioResult> {
  const start = Date.now();
  let status: ScenarioStatus = 'pending';
  let assertions: AssertionResult[] = [];
  let error: string | undefined;
  let stack: string | undefined;

  try {
    switch (scenario.category) {
      case 'policy':
        assertions = await runPolicyScenario(scenario);
        break;
      case 'context':
        assertions = runContextScenario(scenario);
        break;
      case 'transport':
        assertions = runTransportScenario(scenario);
        break;
      case 'memory':
        assertions = await runMemoryScenario(scenario);
        break;
      case 'security':
        assertions = await runSecurityScenario(scenario);
        break;
      case 'handoff':
        assertions = await runHandoffScenario(scenario);
        break;
      default:
        status = 'skipped';
    }

    if (status !== 'skipped') {
      status = assertions.every((a) => a.passed) ? 'passed' : 'failed';
    }
  } catch (err) {
    status = 'errored';
    error = err instanceof Error ? err.message : String(err);
    stack = err instanceof Error ? err.stack : undefined;
  }

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    category: scenario.category,
    status,
    durationMs: Date.now() - start,
    assertions,
    error,
    stack,
  };
}

/**
 * Run a single eval scenario.
 */
export async function runScenario(scenario: EvalScenario): Promise<ScenarioResult> {
  return executeScenario(scenario);
}

/**
 * Run an entire eval suite (array of scenarios) and produce aggregated results.
 */
export async function runEvalSuite(
  suiteId: string,
  suiteName: string,
  scenarios: EvalScenario[],
): Promise<EvalSuiteResult> {
  const start = Date.now();
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const result = await executeScenario(scenario);
    results.push(result);
  }

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'errored').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const overallStatus = errored > 0 ? 'errored' : failed > 0 ? 'failed' : 'passed';

  // Build per-split summaries if any scenarios have split assignments
  const hasSplits = scenarios.some((s) => s.split != null);
  let splitResults: Record<EvalSplit, SplitResult> | undefined;

  if (hasSplits) {
    const splitMap = new Map<EvalSplit, CaseOutcome[]>();
    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i];
      const result = results[i];
      const split = scenario.split ?? 'train';
      if (!splitMap.has(split)) splitMap.set(split, []);
      splitMap.get(split)?.push(toCaseOutcome(scenario, result));
    }

    splitResults = {} as Record<EvalSplit, SplitResult>;
    for (const [split, outcomes] of splitMap) {
      splitResults[split] = buildSplitResult(split, 'default', outcomes);
    }
  }

  return {
    suiteId,
    suiteName,
    status: overallStatus,
    total: scenarios.length,
    passed,
    failed,
    errored,
    skipped,
    results,
    durationMs: Date.now() - start,
    completedAt: Date.now(),
    splitResults,
  };
}

/**
 * Run a policy scenario with custom rules pre-registered.
 * Convenience wrapper that accepts rules alongside the scenario.
 */
export async function runPolicyScenarioWithRules(
  scenario: PolicyScenario,
  rules: PolicyRule[],
): Promise<ScenarioResult> {
  const engine = new PolicyEngine();
  for (const rule of rules) {
    engine.register(rule);
  }

  const start = Date.now();
  const assertions: AssertionResult[] = [];

  const ctx: PolicyContext = {
    runId: scenario.context.runId ?? 'eval-run',
    agentId: scenario.context.agentId ?? 'eval-agent',
    turnIndex: scenario.context.turnIndex ?? 0,
    proposal: scenario.proposal,
    runSpendUSD: scenario.context.runSpendUSD,
    totalTokens: scenario.context.totalTokens,
    metadata: scenario.context.metadata,
  };

  const decision = await engine.evaluate(ctx);

  assertions.push(assert('verdict', scenario.expected.verdict, decision.verdict));

  if (scenario.expected.riskScoreRange) {
    assertions.push(
      assertInRange(
        'riskScore',
        decision.riskScore,
        scenario.expected.riskScoreRange[0],
        scenario.expected.riskScoreRange[1],
      ),
    );
  }

  if (scenario.expected.triggeredRuleIds) {
    const failedIds = decision.checks.filter((c) => !c.passed).map((c) => c.ruleId);
    for (const ruleId of scenario.expected.triggeredRuleIds) {
      assertions.push(assertIncludes(`triggered rule ${ruleId}`, failedIds, ruleId));
    }
  }

  if (scenario.expected.passedRuleIds) {
    const passedIds = decision.checks.filter((c) => c.passed).map((c) => c.ruleId);
    for (const ruleId of scenario.expected.passedRuleIds) {
      assertions.push(assertIncludes(`passed rule ${ruleId}`, passedIds, ruleId));
    }
  }

  const status: ScenarioStatus = assertions.every((a) => a.passed) ? 'passed' : 'failed';

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    category: 'policy',
    status,
    durationMs: Date.now() - start,
    assertions,
  };
}

// ── Split-Aware Helpers ──

/**
 * Build a CaseOutcome from a scenario and its result.
 */
export function toCaseOutcome(scenario: EvalScenario, result: ScenarioResult): CaseOutcome {
  return {
    caseId: scenario.id,
    split: scenario.split ?? 'train',
    stratum: scenario.stratum ?? scenario.category,
    status: result.status,
    score: result.status === 'passed' ? 1.0 : 0.0,
    failureMessage: result.error ?? (result.status === 'failed'
      ? result.assertions.filter((a) => !a.passed).map((a) => `${a.label}: expected ${a.expected}, got ${a.actual}`).join('; ')
      : undefined),
    traceRef: result.traceRef,
    scenarioResult: result,
  };
}

/**
 * Build a SplitResult from a set of case outcomes.
 */
export function buildSplitResult(split: EvalSplit, variant: string, outcomes: CaseOutcome[]): SplitResult {
  const passed = outcomes.filter((o) => o.status === 'passed').length;
  const total = outcomes.length;
  return {
    split,
    variant,
    passed,
    total,
    outcomes,
    correctness: total > 0 ? passed / total : 1.0,
    failingOutcomes: outcomes.filter((o) => o.status !== 'passed'),
  };
}

/**
 * Run scenarios for a specific split and produce a SplitResult.
 */
export async function runSplit(
  scenarios: EvalScenario[],
  split: EvalSplit,
  variant: string = 'default',
): Promise<SplitResult> {
  const filtered = scenarios.filter((s) => s.split === split);
  const outcomes: CaseOutcome[] = [];

  for (const scenario of filtered) {
    const result = await executeScenario(scenario);
    outcomes.push(toCaseOutcome(scenario, result));
  }

  return buildSplitResult(split, variant, outcomes);
}

/**
 * Validate that train and holdout splits have matching strata sets.
 * Returns warnings (not errors) for imbalanced splits.
 */
export function validateSplitBalance(scenarios: EvalScenario[]): StrataValidation {
  const trainStrata = new Set<string>();
  const holdoutStrata = new Set<string>();

  for (const s of scenarios) {
    const stratum = s.stratum ?? s.category;
    if (s.split === 'train') trainStrata.add(stratum);
    else if (s.split === 'holdout') holdoutStrata.add(stratum);
  }

  const trainArr = [...trainStrata].sort();
  const holdoutArr = [...holdoutStrata].sort();
  const missingFromHoldout = trainArr.filter((s) => !holdoutStrata.has(s));
  const missingFromTrain = holdoutArr.filter((s) => !trainStrata.has(s));
  const balanced = missingFromHoldout.length === 0 && missingFromTrain.length === 0;

  const warnings: string[] = [];
  if (missingFromHoldout.length > 0) {
    warnings.push(`Strata in train but not holdout: ${missingFromHoldout.join(', ')}. Holdout cannot measure generalization for these categories.`);
  }
  if (missingFromTrain.length > 0) {
    warnings.push(`Strata in holdout but not train: ${missingFromTrain.join(', ')}. These holdout cases have no corresponding train signal.`);
  }

  return { balanced, trainStrata: trainArr, holdoutStrata: holdoutArr, missingFromHoldout, missingFromTrain, warnings };
}
