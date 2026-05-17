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
  EvalSplit,
  CaseOutcome,
  SplitResult,
  StrataValidation,
} from './types';

// Runner
export {
  runScenario,
  runEvalSuite,
  runPolicyScenarioWithRules,
  runSplit,
  validateSplitBalance,
  toCaseOutcome,
  buildSplitResult,
} from './runner';

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
export type { ScenarioOverrides } from './scenarios';

// Surfaces
export type {
  HarnessSurfaceKind,
  HarnessSurface,
  HarnessVariant,
  VariantDiff,
} from './surfaces';
export {
  extractSurfaces,
  buildVariant,
  buildVariantFromDef,
  applyVariant,
  diffVariants,
} from './surfaces';

// Experiment
export type {
  AcceptanceCriteria,
  ExperimentConfig,
  IterationDiagnosis,
  IterationRecord,
  ExperimentReport,
} from './experiment';
export { runExperiment } from './experiment';

// Stateful evaluation (Phase 5)
export {
  diffMemorySnapshots,
  RubricStateJudge,
  runStatefulScenarios,
  compareTrajectories,
  gateRegressions,
} from './stateful';
export type {
  MemoryEntrySnapshot,
  MemorySnapshot,
  MemoryDiff,
  TrajectoryTurnSnapshot,
  StatefulTrajectory,
  StateRubricCriterion,
  JudgeResult,
  StateJudge,
  StatefulScenarioRun,
  StatefulRunReport,
  StatefulScenarioInput,
  StatefulRunnerOptions,
  RegressionEntry,
  RegressionReport,
} from './stateful';
