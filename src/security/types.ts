/**
 * @packageDocumentation
 * @module SecurityTypes
 * @description
 * Types for the security policy pack system.
 *
 * A SecurityPolicyPack is a named, versioned bundle of PolicyRules
 * and RuntimeHooks that can be registered/removed atomically.
 */

import type { PolicyRule } from '../policy/PolicyEngine';
import type { RuntimeHook } from '../types/hooks';

// ── Security Policy Pack ──

/** A composable bundle of security rules and hooks. */
export interface SecurityPolicyPack {
  /** Unique pack identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** What this pack defends against. */
  description: string;
  /** Semantic version. */
  version: string;
  /** Policy rules contributed by this pack. */
  rules: PolicyRule[];
  /** Runtime hooks contributed by this pack. */
  hooks: RuntimeHook[];
}

/** Options for the SecurityPolicyPackManager. */
export interface SecurityPackManagerOptions {
  /** Emit trace events when packs are registered/removed. */
  traceRegistration?: boolean;
}

// ── Pack Factory Options ──

/** Options for the injection detection pack. */
export interface InjectionDetectionPackOptions {
  /** Additional regex patterns to scan for. */
  customPatterns?: Array<{
    category: string;
    pattern: RegExp;
    severity: 'critical' | 'high' | 'medium';
    description: string;
  }>;
  /** Risk score threshold to escalate (default: 0.5). */
  escalateThreshold?: number;
  /** Risk score threshold to block (default: 0.8). */
  blockThreshold?: number;
}

/** Options for the tool poisoning pack. */
export interface ToolPoisoningPackOptions {
  /** Whether to auto-strip hidden content (default: true). */
  autoSanitize?: boolean;
  /** Whether to block when tool description changes from pin (default: true). */
  blockOnPinViolation?: boolean;
}

/** Options for the handoff safety pack. */
export interface HandoffSafetyPackOptions {
  /** Allowed agent IDs for handoff targets. Empty = allow all. */
  allowedTargets?: string[];
  /** Blocked agent IDs (takes precedence over allowedTargets). */
  blockedTargets?: string[];
  /** Require explicit handoff approval (verdict: escalate). */
  requireApproval?: boolean;
}

/** Options for the model restriction pack. */
export interface ModelRestrictionPackOptions {
  /** Allowed model identifiers (e.g. 'gpt-4o', 'claude-sonnet-4-20250514'). */
  allowedModels?: string[];
  /** Allowed provider names (e.g. 'openai', 'anthropic'). */
  allowedProviders?: string[];
  /** Block unknown models/providers (default: true). */
  blockUnknown?: boolean;
}

/** Options for the budget ceiling pack. */
export interface BudgetCeilingPackOptions {
  /** Max USD spend per run. */
  maxRunSpendUSD?: number;
  /** Max tokens per run. */
  maxTokenBudget?: number;
  /** Spend threshold to flag (default: 80% of maxRunSpendUSD). */
  flagThresholdPercent?: number;
}

/** Options for the endpoint allowlist pack. */
export interface EndpointAllowlistPackOptions {
  /** Allowed endpoint URL patterns (glob or exact). */
  allowedEndpoints: string[];
  /** Blocked endpoint URL patterns (takes precedence). */
  blockedEndpoints?: string[];
}
