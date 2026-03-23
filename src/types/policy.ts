/**
 * @packageDocumentation
 * @module PolicyTypes
 * @description
 * Policy decision types for the Veridex Agent Fabric.
 *
 * These types compose with the existing agentic-payments VerdictResult
 * when available, and provide a standalone policy layer when not.
 */

// ── Policy Verdict ──

/** The four possible outcomes of policy evaluation. */
export type PolicyVerdict = 'pass' | 'flag' | 'escalate' | 'block';

/** Result of a policy evaluation. */
export interface PolicyDecision {
  /** Final verdict */
  verdict: PolicyVerdict;
  /** Aggregate risk score (0-100) */
  riskScore: number;
  /** Human-readable reasons */
  reasons: string[];
  /** Individual rule check results */
  checks: PolicyCheckResult[];
  /** Timestamp of evaluation */
  evaluatedAt: number;
}

/** Result of a single policy check. */
export interface PolicyCheckResult {
  /** Rule identifier */
  ruleId: string;
  /** Rule name */
  ruleName: string;
  /** Whether the check passed */
  passed: boolean;
  /** Verdict from this rule */
  verdict: PolicyVerdict;
  /** Explanation */
  reason: string;
  /** Risk contribution (0-100) */
  riskContribution: number;
}
