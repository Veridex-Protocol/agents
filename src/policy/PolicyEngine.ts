/**
 * @module PolicyEngine
 * Runtime policy evaluation engine.
 * Evaluates tool calls, payments, memory writes, and handoffs against
 * registered policy rules to produce deterministic verdicts.
 */

import type {
  PolicyDecision,
  PolicyVerdict,
  PolicyCheckResult,
} from '../types/policy';
import type { ToolContract, ToolSafetyClass } from '../types/tools';
import type { ActionProposal } from '../types/proposals';

// ── Policy Rule Interface ──

/** Context provided to policy rules during evaluation. */
export interface PolicyContext {
  runId: string;
  agentId: string;
  turnIndex: number;
  proposal: ActionProposal;
  /** Total spend so far in this run (USD). */
  runSpendUSD?: number;
  /** Total tokens used so far. */
  totalTokens?: number;
  /** Custom context data for domain-specific rules. */
  metadata?: Record<string, unknown>;
}

/** A single policy rule that evaluates part of a proposal. */
export interface PolicyRule {
  /** Unique rule identifier. */
  id: string;
  /** Human-readable rule name. */
  name: string;
  /** Rule description for audit. */
  description: string;
  /** Priority (lower = evaluated first). */
  priority?: number;
  /** Evaluate the rule against a context. */
  evaluate(ctx: PolicyContext): PolicyCheckResult | Promise<PolicyCheckResult>;
}

// ── Built-in Rules ──

/** Block proposals targeting specific tool safety classes. */
export function blockSafetyClasses(
  classes: ToolSafetyClass[],
  tools: Map<string, ToolContract>,
): PolicyRule {
  return {
    id: 'builtin:block-safety-classes',
    name: 'Block Safety Classes',
    description: `Block tools with safety classes: ${classes.join(', ')}`,
    evaluate(ctx) {
      if (ctx.proposal.type !== 'tool_call') {
        return { ruleId: this.id, ruleName: this.name, passed: true, verdict: 'pass', reason: 'Not a tool call', riskContribution: 0 };
      }
      for (const tc of ctx.proposal.toolCalls) {
        const tool = tools.get(tc.name);
        if (tool && classes.includes(tool.safetyClass)) {
          return {
            ruleId: this.id,
            ruleName: this.name,
            passed: false,
            verdict: 'block',
            reason: `Tool '${tc.name}' has blocked safety class '${tool.safetyClass}'`,
            riskContribution: 1.0,
          };
        }
      }
      return { ruleId: this.id, ruleName: this.name, passed: true, verdict: 'pass', reason: 'No blocked classes', riskContribution: 0 };
    },
  };
}

/** Require approval for tools with specific safety classes. */
export function requireApprovalFor(classes: ToolSafetyClass[], tools: Map<string, ToolContract>): PolicyRule {
  return {
    id: 'builtin:require-approval',
    name: 'Require Approval',
    description: `Require approval for tools with classes: ${classes.join(', ')}`,
    evaluate(ctx) {
      if (ctx.proposal.type !== 'tool_call') {
        return { ruleId: this.id, ruleName: this.name, passed: true, verdict: 'pass', reason: 'Not a tool call', riskContribution: 0 };
      }
      for (const tc of ctx.proposal.toolCalls) {
        const tool = tools.get(tc.name);
        if (tool && classes.includes(tool.safetyClass)) {
          return {
            ruleId: this.id,
            ruleName: this.name,
            passed: false,
            verdict: 'escalate',
            reason: `Tool '${tc.name}' (class: '${tool.safetyClass}') requires approval`,
            riskContribution: 0.7,
          };
        }
      }
      return { ruleId: this.id, ruleName: this.name, passed: true, verdict: 'pass', reason: 'No tools require approval', riskContribution: 0 };
    },
  };
}

/** Enforce a per-run spending limit. */
export function maxRunSpendUSD(limit: number): PolicyRule {
  return {
    id: 'builtin:max-run-spend',
    name: 'Max Run Spend',
    description: `Block if run spend exceeds $${limit}`,
    evaluate(ctx) {
      if ((ctx.runSpendUSD ?? 0) > limit) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'block',
          reason: `Run spend $${ctx.runSpendUSD} exceeds limit $${limit}`,
          riskContribution: 1.0,
        };
      }
      return { ruleId: this.id, ruleName: this.name, passed: true, verdict: 'pass', reason: `Spend within limit ($${ctx.runSpendUSD ?? 0}/$${limit})`, riskContribution: 0 };
    },
  };
}

/** Enforce a per-run token budget. */
export function maxTokenBudget(limit: number): PolicyRule {
  return {
    id: 'builtin:max-token-budget',
    name: 'Max Token Budget',
    description: `Block if total tokens exceed ${limit}`,
    evaluate(ctx) {
      if ((ctx.totalTokens ?? 0) > limit) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'block',
          reason: `Total tokens ${ctx.totalTokens} exceeds budget ${limit}`,
          riskContribution: 0.8,
        };
      }
      return { ruleId: this.id, ruleName: this.name, passed: true, verdict: 'pass', reason: 'Within token budget', riskContribution: 0 };
    },
  };
}

/** Allow only specific chains for financial operations. */
export function allowChains(chains: string[]): PolicyRule {
  const allowed = new Set(chains.map((c) => c.toLowerCase()));
  return {
    id: 'builtin:allow-chains',
    name: 'Allow Chains',
    description: `Allow only chains: ${chains.join(', ')}`,
    evaluate(ctx) {
      if (ctx.proposal.type !== 'tool_call') {
        return { ruleId: this.id, ruleName: this.name, passed: true, verdict: 'pass', reason: 'Not a tool call', riskContribution: 0 };
      }
      for (const tc of ctx.proposal.toolCalls) {
        const chain = tc.arguments.chain as string | undefined;
        if (chain && !allowed.has(chain.toLowerCase())) {
          return {
            ruleId: this.id,
            ruleName: this.name,
            passed: false,
            verdict: 'block',
            reason: `Chain '${chain}' is not in allowed list: ${chains.join(', ')}`,
            riskContribution: 1.0,
          };
        }
      }
      return { ruleId: this.id, ruleName: this.name, passed: true, verdict: 'pass', reason: 'Chain allowed', riskContribution: 0 };
    },
  };
}

/** Bump risk score when the agent lacks a verified response envelope. */
export function requireVerifiedEnvelope(riskBump = 0.5): PolicyRule {
  return {
    id: 'builtin:require-verified-envelope',
    name: 'Require Verified Envelope',
    description: 'Flags runs where the response envelope is absent or unverified',
    evaluate(ctx) {
      const envelope = ctx.metadata?.responseEnvelope;
      if (!envelope) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: true,
          verdict: 'flag',
          reason: 'No response envelope — integrity unverifiable',
          riskContribution: riskBump,
        };
      }
      const integrityBinding = ctx.metadata?.integrityBinding;
      if (!integrityBinding) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: true,
          verdict: 'flag',
          reason: 'Response envelope present but no integrity binding — limited trust',
          riskContribution: riskBump * 0.5,
        };
      }
      return { ruleId: this.id, ruleName: this.name, passed: true, verdict: 'pass', reason: 'Verified envelope and integrity binding present', riskContribution: 0 };
    },
  };
}

// ── Policy Engine ──

/** Severity order for verdicts (most severe first). */
const VERDICT_SEVERITY: Record<PolicyVerdict, number> = {
  block: 3,
  escalate: 2,
  flag: 1,
  pass: 0,
};

export class PolicyEngine {
  private rules: PolicyRule[] = [];

  /** Register a policy rule. */
  register(rule: PolicyRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  /** Remove a policy rule by ID. */
  remove(ruleId: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  /** List all registered rules. */
  list(): PolicyRule[] {
    return [...this.rules];
  }

  /** Clear all rules. */
  clear(): void {
    this.rules = [];
  }

  /**
   * Evaluate all rules against a proposal context.
   * Returns a deterministic PolicyDecision with the most severe verdict.
   */
  async evaluate(ctx: PolicyContext): Promise<PolicyDecision> {
    const checks: PolicyCheckResult[] = [];
    const reasons: string[] = [];
    let worstVerdict: PolicyVerdict = 'pass';
    let totalRisk = 0;

    for (const rule of this.rules) {
      try {
        const result = await rule.evaluate(ctx);
        checks.push(result);

        if (!result.passed) {
          reasons.push(result.reason);
        }

        if (VERDICT_SEVERITY[result.verdict] > VERDICT_SEVERITY[worstVerdict]) {
          worstVerdict = result.verdict;
        }

        totalRisk += result.riskContribution ?? 0;

        // Short-circuit on block
        if (result.verdict === 'block') break;
      } catch (err) {
        const failResult: PolicyCheckResult = {
          ruleId: rule.id,
          ruleName: rule.name,
          passed: false,
          verdict: 'flag',
          reason: `Rule evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
          riskContribution: 0.5,
        };
        checks.push(failResult);
        reasons.push(failResult.reason);
        totalRisk += 0.5;

        if (VERDICT_SEVERITY[failResult.verdict] > VERDICT_SEVERITY[worstVerdict]) {
          worstVerdict = failResult.verdict;
        }
      }
    }

    return {
      verdict: worstVerdict,
      riskScore: Math.min(totalRisk, 1.0),
      reasons,
      checks,
      evaluatedAt: Date.now(),
    };
  }
}
