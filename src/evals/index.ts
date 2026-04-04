/**
 * @module Evals
 * @description
 * Eval and regression layer for the Veridex Agent Fabric.
 *
 * Provides typed eval scenarios, a scenario runner, and built-in
 * regression scenario factories for policy, context, transport,
 * memory, security, and handoff subsystems.
 */

// Types
export type {
  ScenarioStatus,
  ScenarioCategory,
  BaseScenario,
  PolicyScenario,
  ContextScenario,
  ContextSection as EvalContextSection,
  TransportScenario,
  MemoryScenario,
  SecurityScenario,
  HandoffScenario,
  EvalScenario,
  ScenarioResult,
  AssertionResult,
  EvalSuiteResult,
} from './types';

// Runner
export { runScenario, runEvalSuite, runPolicyScenarioWithRules } from './runner';

// Built-in scenarios
export {
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
} from './scenarios';
