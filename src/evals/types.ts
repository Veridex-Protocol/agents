/**
 * @module EvalTypes
 * @description
 * Typed eval scenario definitions for regression testing
 * across policy, context assembly, transport, memory, and security.
 */

import type { PolicyVerdict, PolicyCheckResult } from '../types/policy';
import type { ActionProposal } from '../types/proposals';

// ── Scenario Status ──

export type ScenarioStatus = 'pending' | 'passed' | 'failed' | 'errored' | 'skipped';

// ── Base Scenario ──

export interface BaseScenario {
  /** Unique scenario identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this scenario validates */
  description: string;
  /** Category for grouping */
  category: ScenarioCategory;
  /** Tags for filtering */
  tags?: string[];
  /** Timeout in ms (default 5000) */
  timeoutMs?: number;
}

export type ScenarioCategory =
  | 'policy'
  | 'context'
  | 'transport'
  | 'memory'
  | 'security'
  | 'handoff'
  | 'orchestration'
  | 'custom';

// ── Policy Scenario ──

export interface PolicyScenario extends BaseScenario {
  category: 'policy';
  /** The proposal to evaluate */
  proposal: ActionProposal;
  /** Policy context overrides */
  context: {
    runId?: string;
    agentId?: string;
    turnIndex?: number;
    runSpendUSD?: number;
    totalTokens?: number;
    metadata?: Record<string, unknown>;
  };
  /** Expected outcome */
  expected: {
    verdict: PolicyVerdict;
    /** If set, check that risk score is within this range */
    riskScoreRange?: [number, number];
    /** If set, check specific rules were triggered */
    triggeredRuleIds?: string[];
    /** If set, check specific rules passed */
    passedRuleIds?: string[];
  };
}

// ── Context Assembly Scenario ──

export interface ContextSection {
  source: string;
  content: string;
  priority: number;
  budgetTokens?: number;
}

export interface ContextScenario extends BaseScenario {
  category: 'context';
  /** Sections to compile */
  sections: ContextSection[];
  /** Max token budget */
  maxTokens: number;
  /** Expected outcome */
  expected: {
    /** Expected total tokens within range */
    totalTokensRange?: [number, number];
    /** Whether truncation should have occurred */
    hadTruncation: boolean;
    /** Sources that should appear in output (order matters if ordered=true) */
    includedSources: string[];
    /** Sources that should NOT appear in output */
    excludedSources?: string[];
    /** Whether source order matters */
    ordered?: boolean;
  };
}

// ── Transport/Circuit Breaker Scenario ──

export interface TransportScenario extends BaseScenario {
  category: 'transport';
  /** Sequence of call outcomes to simulate */
  callSequence: Array<{
    /** Whether the call succeeds */
    success: boolean;
    /** Duration in ms */
    durationMs?: number;
    /** Error message if failed */
    error?: string;
  }>;
  /** Configuration overrides */
  config?: {
    maxRetries?: number;
    baseDelayMs?: number;
    failureThreshold?: number;
    resetTimeoutMs?: number;
  };
  /** Expected outcome */
  expected: {
    /** Whether the final call succeeds */
    finalSuccess: boolean;
    /** Expected circuit breaker state after the sequence */
    circuitState?: 'closed' | 'open' | 'half-open';
    /** Expected total attempts */
    totalAttempts?: number;
  };
}

// ── Memory/State Scenario ──

export interface MemoryScenario extends BaseScenario {
  category: 'memory';
  /** Initial memory entries to seed */
  seedEntries: Array<{
    content: string;
    kind?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }>;
  /** Operations to perform */
  operations: Array<
    | { type: 'write'; content: string; kind?: string; tags?: string[] }
    | { type: 'search'; query: string; expectedMinResults: number; expectedMaxResults?: number }
    | { type: 'read'; tag: string; expectedCount: number }
  >;
  /** Expected final state */
  expected: {
    /** Total entry count after all operations */
    totalEntries: number;
  };
}

// ── Security Pack Scenario ──

export interface SecurityScenario extends BaseScenario {
  category: 'security';
  /** Which security pack to test */
  packType: 'injection' | 'tool_poisoning' | 'handoff_safety' | 'model_restriction' | 'budget_ceiling' | 'endpoint_allowlist';
  /** Pack configuration */
  packConfig: Record<string, unknown>;
  /** Input to test against the pack */
  input: {
    proposal?: ActionProposal;
    hookContext?: Record<string, unknown>;
  };
  /** Expected outcome */
  expected: {
    /** Expected policy verdict (if pack adds a rule) */
    verdict?: PolicyVerdict;
    /** Whether the input should be caught/blocked */
    shouldBlock: boolean;
    /** Expected trigger reasons (substring matches) */
    triggerReasons?: string[];
  };
}

// ── Handoff Scenario ──

export interface HandoffScenario extends BaseScenario {
  category: 'handoff';
  /** Source agent ID */
  sourceAgentId: string;
  /** Target agent ID */
  targetAgentId: string;
  /** Handoff reason */
  reason: string;
  /** Allowlist / blocklist config */
  config?: {
    allowList?: string[];
    blockList?: string[];
    requireApproval?: boolean;
  };
  /** Expected outcome */
  expected: {
    /** Whether handoff should be allowed */
    allowed: boolean;
    /** Expected verdict if policy-governed */
    verdict?: PolicyVerdict;
  };
}

// ── Discriminated Union ──

export type EvalScenario =
  | PolicyScenario
  | ContextScenario
  | TransportScenario
  | MemoryScenario
  | SecurityScenario
  | HandoffScenario;

// ── Scenario Result ──

export interface ScenarioResult {
  /** Scenario ID */
  scenarioId: string;
  /** Scenario name */
  scenarioName: string;
  /** Category */
  category: ScenarioCategory;
  /** Pass/Fail/Error status */
  status: ScenarioStatus;
  /** Duration in ms */
  durationMs: number;
  /** Assertion results */
  assertions: AssertionResult[];
  /** Error message if errored */
  error?: string;
  /** Stack trace if errored */
  stack?: string;
}

export interface AssertionResult {
  /** What was being checked */
  label: string;
  /** Whether it passed */
  passed: boolean;
  /** Expected value (stringified) */
  expected: string;
  /** Actual value (stringified) */
  actual: string;
}

// ── Suite Runner Result ──

export interface EvalSuiteResult {
  /** Suite identifier */
  suiteId: string;
  /** Suite name */
  suiteName: string;
  /** Overall status */
  status: 'passed' | 'failed' | 'errored';
  /** Total scenario count */
  total: number;
  /** Passed count */
  passed: number;
  /** Failed count */
  failed: number;
  /** Errored count */
  errored: number;
  /** Skipped count */
  skipped: number;
  /** Per-scenario results */
  results: ScenarioResult[];
  /** Total suite duration */
  durationMs: number;
  /** Timestamp */
  completedAt: number;
}
