/**
 * @packageDocumentation
 * @module IntentVerificationPack
 * @description
 * Security policy pack that makes IntentVerification mandatory
 * for financial, destructive, and privileged tool safety classes.
 *
 * Addresses AC-1 (payload injection) and AC-1.b (conditional delivery)
 * from "Your Agent Is Mine" (Shou et al., 2026).
 *
 * Previously, IntentVerification was opt-in/nullable. This pack
 * installs it as a default-on beforeToolExecute hook that blocks
 * tool calls which fail the keyword blocklist or NLI alignment check.
 */

import type { PolicyRule, PolicyContext } from '../policy/PolicyEngine';
import type { PolicyCheckResult } from '../types/policy';
import type { RuntimeHook, HookResult, ToolHookContext } from '../types/hooks';
import type { SecurityPolicyPack } from './types';
import {
  KeywordFilter,
  BenignOverride,
  DEFAULT_FINANCIAL_BLOCKLIST,
  type IntentContext,
} from '../intent/IntentVerification';

// ── Types ──

export interface IntentVerificationPackOptions {
  /** Tool safety classes that require intent verification. Default: financial, destructive, privileged. */
  enforcedSafetyClasses?: string[];
  /** Additional keyword blocklist patterns (merged with DEFAULT_FINANCIAL_BLOCKLIST). */
  additionalBlocklist?: string[];
  /** Keyword allowlist patterns. */
  keywordAllowlist?: string[];
  /** Safe patterns for benign override (known-safe actions). */
  safePatterns?: string[];
  /** Maximum USD amount for benign auto-approval (default: 100). */
  maxAutoApproveUSD?: number;
  /** Tool names that are always gated regardless of safety class. */
  alwaysGatedTools?: string[];
  /** Tool names that are exempt from intent verification. */
  exemptTools?: string[];
}

// ── Extended blocklist for destructive/privileged actions ──

const DESTRUCTIVE_BLOCKLIST: string[] = [
  'delete\\s+all',
  'drop\\s+(?:table|database|collection)',
  'truncate\\s+table',
  'rm\\s+-rf',
  'format\\s+disk',
  'wipe\\s+data',
  'destroy\\s+(?:account|vault|wallet)',
  'revoke\\s+all\\s+permissions',
  'disable\\s+(?:security|firewall|auth)',
  'override\\s+(?:safety|security|policy)',
];

const PRIVILEGED_BLOCKLIST: string[] = [
  'escalate\\s+(?:privilege|permission)',
  'become\\s+(?:admin|root|superuser)',
  'grant\\s+(?:admin|superuser|root)',
  'bypass\\s+(?:auth|approval|policy)',
  'modify\\s+(?:admin|owner|authority)',
  'change\\s+(?:admin|owner|authority)',
  'deploy\\s+(?:contract|smart\\s+contract).*?(?:unaudited|unsafe)',
];

// ── Default safe patterns ──

const DEFAULT_SAFE_PATTERNS: string[] = [
  // Read-only operations
  'get\\s+balance',
  'check\\s+(?:status|balance|price)',
  'view\\s+(?:account|transaction|history)',
  'list\\s+(?:tokens|nfts|transactions)',
  'fetch\\s+(?:price|rate|data)',
  'read\\s+(?:config|settings)',
  'query\\s+(?:data|info)',
];

// ── Implementation ──

export function intentVerificationPack(opts?: IntentVerificationPackOptions): SecurityPolicyPack {
  const enforcedClasses = new Set(
    opts?.enforcedSafetyClasses ?? ['financial', 'destructive', 'privileged'],
  );
  const alwaysGated = new Set(opts?.alwaysGatedTools ?? []);
  const exempt = new Set(opts?.exemptTools ?? []);
  const maxAutoApproveUSD = opts?.maxAutoApproveUSD ?? 100;

  // Build the composite blocklist
  const fullBlocklist = [
    ...DEFAULT_FINANCIAL_BLOCKLIST,
    ...DESTRUCTIVE_BLOCKLIST,
    ...PRIVILEGED_BLOCKLIST,
    ...(opts?.additionalBlocklist ?? []),
  ];

  // Instantiate the keyword filter and benign override
  const keywordFilter = new KeywordFilter({
    blocklist: fullBlocklist,
    allowlist: opts?.keywordAllowlist,
  });

  const benignOverride = new BenignOverride({
    safePatterns: opts?.safePatterns ?? DEFAULT_SAFE_PATTERNS,
    maxAutoApproveUSD,
  });

  /** Determine if a tool call should be gated. */
  function shouldGate(toolName: string, safetyClass: string): boolean {
    if (exempt.has(toolName)) return false;
    if (alwaysGated.has(toolName)) return true;
    return enforcedClasses.has(safetyClass);
  }

  /** Build intent context from proposal/hook context. */
  function buildIntentContext(
    toolName: string,
    toolArgs: Record<string, unknown>,
    agentId: string,
  ): IntentContext {
    // Extract action description from tool args
    const action = (toolArgs.description as string)
      ?? (toolArgs.action as string)
      ?? (toolArgs.command as string)
      ?? (toolArgs.input as string)
      ?? JSON.stringify(toolArgs).slice(0, 500);

    const amountUSD = typeof toolArgs.amountUSD === 'number' ? toolArgs.amountUSD
      : typeof toolArgs.amount === 'number' ? toolArgs.amount
      : typeof toolArgs.value === 'number' ? toolArgs.value
      : undefined;

    return {
      action: `Tool: ${toolName}. Args: ${action}`,
      agentId,
      target: (toolArgs.target as string) ?? (toolArgs.to as string) ?? (toolArgs.address as string),
      amountUSD,
      chain: (toolArgs.chain as string) ?? (toolArgs.chainId as string),
      metadata: { toolName, rawArgs: toolArgs },
    };
  }

  // ── Policy Rule ──

  const ruleId = 'security:intent-verification';
  const ruleName = 'Intent Verification (Default-On)';

  const rule: PolicyRule = {
    id: ruleId,
    name: ruleName,
    description: 'Mandatory intent verification for financial/destructive/privileged tool calls',
    priority: 8,
    evaluate(ctx: PolicyContext): PolicyCheckResult {
      if (ctx.proposal.type !== 'tool_call') {
        return { ruleId, ruleName, passed: true, verdict: 'pass', reason: 'Not a tool call', riskContribution: 0 };
      }

      for (const tc of ctx.proposal.toolCalls) {
        const safetyClass = (ctx.metadata?.toolSafetyClasses as Record<string, string>)?.[tc.name] ?? 'unknown';
        if (!shouldGate(tc.name, safetyClass)) continue;

        const intentCtx = buildIntentContext(
          tc.name,
          tc.arguments,
          (ctx.metadata?.agentId as string) ?? 'unknown',
        );

        // Run keyword filter (synchronous)
        const kwResult = keywordFilter.check(intentCtx.action);
        if (!kwResult.passed) {
          return {
            ruleId, ruleName, passed: false, verdict: 'block',
            reason: `Intent verification failed: ${kwResult.reason}`,
            riskContribution: 1.0,
          };
        }

        // Run benign override
        const benignResult = benignOverride.check(intentCtx);
        if (benignResult.passed) continue; // Safe pattern matched

        // If not explicitly safe, flag for review (NLI would run in async hook)
        return {
          ruleId, ruleName, passed: false, verdict: 'escalate',
          reason: `Action requires intent review: "${tc.name}" is in enforced safety class "${safetyClass}"`,
          riskContribution: 0.6,
        };
      }

      return { ruleId, ruleName, passed: true, verdict: 'pass', reason: 'All tool calls passed intent verification', riskContribution: 0 };
    },
  };

  // ── Before-Tool-Execute Hook ──

  const hook: RuntimeHook = {
    name: 'security:intent-verification-hook',
    phase: 'beforeToolExecute',
    priority: 8,
    execute(ctx: unknown): HookResult | undefined {
      const hookCtx = ctx as ToolHookContext;
      if (!hookCtx.toolName) return;

      const safetyClass = hookCtx.safetyClass ?? 'unknown';
      if (!shouldGate(hookCtx.toolName, safetyClass)) return;

      const intentCtx = buildIntentContext(
        hookCtx.toolName,
        hookCtx.toolInput ?? {},
        hookCtx.agentId ?? 'unknown',
      );

      // Keyword filter
      const kwResult = keywordFilter.check(intentCtx.action);
      if (!kwResult.passed) {
        return {
          override: 'deny',
          reason: `Intent blocked: ${kwResult.reason}`,
          annotations: {
            intentVerification: true,
            stage: 'keyword',
            matchedPattern: kwResult.matchedPattern,
          },
        };
      }

      // Benign override
      const benignResult = benignOverride.check(intentCtx);
      if (benignResult.passed) {
        return {
          annotations: {
            intentVerification: true,
            stage: 'benign_override',
            verdict: 'allowed',
          },
        };
      }

      // Not explicitly safe → escalate
      return {
        override: 'pause',
        reason: `Tool "${hookCtx.toolName}" (class: ${safetyClass}) requires intent approval`,
        annotations: {
          intentVerification: true,
          stage: 'escalation',
          safetyClass,
          action: intentCtx.action.slice(0, 200),
        },
      };
    },
  };

  return {
    id: 'security:intent-verification',
    name: 'Intent Verification (Default-On)',
    description: 'Mandatory intent verification for financial, destructive, and privileged tool safety classes. Addresses AC-1 and AC-1.b.',
    version: '1.0.0',
    rules: [rule],
    hooks: [hook],
  };
}
