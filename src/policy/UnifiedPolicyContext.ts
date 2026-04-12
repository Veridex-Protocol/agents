/**
 * @packageDocumentation
 * @module UnifiedPolicyContext
 * @description
 * Unified policy context implementing a hierarchical enforcement model
 * inspired by MAPL (Multi-tier Agentic Policy Language).
 *
 * Extends the base PolicyContext with:
 * - Agent identity claims (OIDC-A)
 * - Agent integrity binding (A-JWT checksum)
 * - Enforcement hierarchy (platform → tenant → workspace → agent)
 * - Delegation chain tracking
 * - Transport-layer context for boundary PEPs
 *
 * @see ADR-0045 — Secure Agentic Payment Rails
 */

import type { PolicyContext } from './PolicyEngine';
import type { AgentIdentityClaims, AgentIntegrityBinding } from '../types/identity';

// ── Enforcement Hierarchy (MAPL) ──

/**
 * Enforcement level in the policy hierarchy.
 * Higher levels (platform) override lower levels (agent).
 * Conflicts resolve by strictest-wins at each level.
 */
export type EnforcementLevel = 'platform' | 'tenant' | 'workspace' | 'agent';

/** Enforcement level priority (lower = higher authority). */
export const ENFORCEMENT_PRIORITY: Record<EnforcementLevel, number> = {
  platform: 0,
  tenant: 1,
  workspace: 2,
  agent: 3,
};

/**
 * A policy constraint attached to a specific enforcement level.
 */
export interface LeveledConstraint {
  /** Which level imposed this constraint */
  level: EnforcementLevel;
  /** Constraint type (e.g., 'spending_limit', 'allowed_tools', 'blocked_chains') */
  constraintType: string;
  /** Constraint value (interpretation depends on constraintType) */
  value: unknown;
  /** Whether this constraint is absolute (cannot be relaxed by lower levels) */
  immutable?: boolean;
}

// ── Delegation Chain ──

/**
 * An entry in the delegation chain — tracks how control was passed
 * from one agent to another (spawning, handoff, or sub-agent invocation).
 */
export interface DelegationEntry {
  /** Delegator agent ID */
  fromAgentId: string;
  /** Delegate agent ID */
  toAgentId: string;
  /** Reason for delegation */
  reason: string;
  /** Timestamp of delegation */
  timestamp: number;
  /** Depth in the delegation tree (0 = root) */
  depth: number;
}

// ── Transport Context ──

/**
 * Transport-layer context for boundary PEPs.
 * Present when the policy evaluation is triggered by a remote call.
 */
export interface TransportPolicyContext {
  /** Transport protocol used */
  protocol: 'mcp' | 'acp' | 'a2a' | 'http' | 'local';
  /** Remote endpoint (if applicable) */
  endpoint?: string;
  /** Whether the connection is authenticated */
  authenticated: boolean;
  /** Authentication method used */
  authMethod?: string;
  /** Caller agent identity (for agent-to-agent calls) */
  callerIdentity?: AgentIdentityClaims;
  /** Whether the caller's integrity binding was verified */
  callerIntegrityVerified?: boolean;
}

// ── Unified Policy Context ──

/**
 * Unified policy context that extends the base PolicyContext with
 * identity, hierarchy, delegation, and transport awareness.
 *
 * Rules can be written against the base PolicyContext for backward
 * compatibility, or against UnifiedPolicyContext for advanced checks.
 */
export interface UnifiedPolicyContext extends PolicyContext {
  // ── Identity ──

  /** Agent identity claims (present when identity is configured) */
  identityClaims?: AgentIdentityClaims;
  /** Agent integrity binding (present when integrity is computed) */
  integrityBinding?: AgentIntegrityBinding;

  // ── Hierarchy ──

  /** Resolved enforcement level for this evaluation */
  enforcementLevel: EnforcementLevel;
  /** Active leveled constraints from all hierarchy levels */
  leveledConstraints?: LeveledConstraint[];
  /** Tenant ID (if operating within a tenant context) */
  tenantId?: string;
  /** Workspace ID (if scoped to a workspace) */
  workspaceId?: string;

  // ── Delegation ──

  /** Delegation chain from root to current agent */
  delegationChain?: DelegationEntry[];
  /** Current delegation depth */
  delegationDepth?: number;

  // ── Transport ──

  /** Transport context (present for remote/cross-boundary calls) */
  transport?: TransportPolicyContext;
}

/**
 * Build a UnifiedPolicyContext from a base PolicyContext and optional enrichment.
 */
export function buildUnifiedPolicyContext(
  base: PolicyContext,
  enrichment?: {
    identityClaims?: AgentIdentityClaims;
    integrityBinding?: AgentIntegrityBinding;
    enforcementLevel?: EnforcementLevel;
    leveledConstraints?: LeveledConstraint[];
    tenantId?: string;
    workspaceId?: string;
    delegationChain?: DelegationEntry[];
    transport?: TransportPolicyContext;
  },
): UnifiedPolicyContext {
  return {
    ...base,
    identityClaims: enrichment?.identityClaims,
    integrityBinding: enrichment?.integrityBinding,
    enforcementLevel: enrichment?.enforcementLevel ?? 'agent',
    leveledConstraints: enrichment?.leveledConstraints,
    tenantId: enrichment?.tenantId,
    workspaceId: enrichment?.workspaceId,
    delegationChain: enrichment?.delegationChain,
    delegationDepth: enrichment?.delegationChain?.length ?? 0,
    transport: enrichment?.transport,
  };
}

/**
 * Resolve leveled constraints by strictest-wins at each level.
 * Higher levels (platform) take precedence over lower levels (agent).
 * Immutable constraints cannot be overridden by any level.
 */
export function resolveConstraints(
  constraints: LeveledConstraint[],
  constraintType: string,
): LeveledConstraint | undefined {
  const matching = constraints
    .filter((c) => c.constraintType === constraintType)
    .sort((a, b) => ENFORCEMENT_PRIORITY[a.level] - ENFORCEMENT_PRIORITY[b.level]);

  // Immutable constraint from highest level wins absolutely
  const immutable = matching.find((c) => c.immutable);
  if (immutable) return immutable;

  // Otherwise highest-authority level wins
  return matching[0];
}

/**
 * Check if the current delegation depth is within allowed bounds.
 */
export function isDelegationAllowed(ctx: UnifiedPolicyContext): boolean {
  const maxDepth = ctx.identityClaims?.maxDelegationDepth ?? Infinity;
  return (ctx.delegationDepth ?? 0) < maxDepth;
}
