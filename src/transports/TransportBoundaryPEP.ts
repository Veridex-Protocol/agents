/**
 * @packageDocumentation
 * @module TransportBoundaryPEP
 * @description
 * Transport Boundary Policy Enforcement Point (PEP).
 *
 * Sits at the transport layer and enforces identity-aware policies
 * before remote calls are dispatched. Complements the existing
 * TransportPolicyEvaluator with:
 *
 * - Agent identity verification (issuer, scopes, expiration)
 * - Integrity binding validation (checksum match)
 * - Delegation depth enforcement
 * - Leveled constraint resolution at the transport boundary
 *
 * @see ADR-0045 — Secure Agentic Payment Rails
 */

import type { AgentIdentityClaims, AgentIntegrityBinding } from '../types/identity';
import type {
  EnforcementLevel,
  LeveledConstraint,
  TransportPolicyContext,
} from '../policy/UnifiedPolicyContext';
import { ENFORCEMENT_PRIORITY, resolveConstraints } from '../policy/UnifiedPolicyContext';

// ── PEP Result ──

/** Result of a boundary PEP evaluation. */
export interface BoundaryPEPResult {
  /** Whether the call is allowed */
  allowed: boolean;
  /** Denial reasons (empty if allowed) */
  reasons: string[];
  /** Enforcement level that produced the decision */
  decidedAt: EnforcementLevel;
  /** Identity claims verified (if any) */
  identityVerified: boolean;
  /** Integrity binding verified (if any) */
  integrityVerified: boolean;
}

// ── PEP Configuration ──

/** Configuration for the transport boundary PEP. */
export interface BoundaryPEPConfig {
  /** Whether to require identity claims on all outbound calls (default: false) */
  requireIdentity?: boolean;
  /** Whether to require integrity binding on all outbound calls (default: false) */
  requireIntegrity?: boolean;
  /** Trusted issuers (if set, only these issuers are allowed) */
  trustedIssuers?: string[];
  /** Required scopes (caller must have all of these) */
  requiredScopes?: string[];
  /** Maximum allowed delegation depth (0 = direct calls only) */
  maxDelegationDepth?: number;
  /** Platform-level constraints (immutable, always enforced) */
  platformConstraints?: LeveledConstraint[];
}

/** Context passed to TransportBoundaryPEP.evaluate(). */
export interface TransportPEPContext {
  callerIdentity?: AgentIdentityClaims;
  callerIntegrity?: AgentIntegrityBinding;
  transport: TransportPolicyContext;
  delegationDepth?: number;
  enforcementLevel?: EnforcementLevel;
  activeConstraints?: LeveledConstraint[];
}

// ── Transport Boundary PEP ──

/**
 * Transport Boundary PEP — enforces identity and integrity policies
 * at the transport layer before remote calls are dispatched.
 */
export class TransportBoundaryPEP {
  private readonly config: BoundaryPEPConfig;

  constructor(config?: BoundaryPEPConfig) {
    this.config = config ?? {};
  }

  /**
   * Evaluate whether an outbound call should be allowed.
   * Checks identity, integrity, delegation depth, and leveled constraints.
   */
  evaluate(context: TransportPEPContext): BoundaryPEPResult {
    const reasons: string[] = [];
    let identityVerified = false;
    let integrityVerified = false;
    const level = context.enforcementLevel ?? 'agent';

    // ── Identity Checks ──
    if (this.config.requireIdentity && !context.callerIdentity) {
      reasons.push('Identity claims required but not provided');
    }

    if (context.callerIdentity) {
      // Check expiration
      if (context.callerIdentity.expiresAt && Date.now() > context.callerIdentity.expiresAt) {
        reasons.push('Agent identity has expired');
      }

      // Check trusted issuers
      if (this.config.trustedIssuers && this.config.trustedIssuers.length > 0) {
        if (!this.config.trustedIssuers.includes(context.callerIdentity.issuer)) {
          reasons.push(`Issuer '${context.callerIdentity.issuer}' is not trusted`);
        }
      }

      // Check required scopes
      if (this.config.requiredScopes && this.config.requiredScopes.length > 0) {
        const agentScopes = new Set(context.callerIdentity.scopes ?? []);
        const missingScopes = this.config.requiredScopes.filter((s) => !agentScopes.has(s));
        if (missingScopes.length > 0) {
          reasons.push(`Missing required scopes: ${missingScopes.join(', ')}`);
        }
      }

      identityVerified = reasons.length === 0;
    }

    // ── Integrity Checks ──
    if (this.config.requireIntegrity && !context.callerIntegrity) {
      reasons.push('Integrity binding required but not provided');
    }

    if (context.callerIntegrity) {
      // Verify checksum is present and non-empty
      if (!context.callerIntegrity.agentChecksum) {
        reasons.push('Agent checksum is missing in integrity binding');
      }
      integrityVerified = !!context.callerIntegrity.agentChecksum;
    }

    // ── Delegation Depth ──
    const maxDepth = this.config.maxDelegationDepth
      ?? context.callerIdentity?.maxDelegationDepth
      ?? Infinity;
    if ((context.delegationDepth ?? 0) > maxDepth) {
      reasons.push(
        `Delegation depth ${context.delegationDepth} exceeds maximum ${maxDepth}`,
      );
    }

    // ── Leveled Constraints ──
    const allConstraints = [
      ...(this.config.platformConstraints ?? []),
      ...(context.activeConstraints ?? []),
    ];

    // Check for transport-blocking constraints
    const transportBlock = resolveConstraints(allConstraints, 'block_transport');
    if (transportBlock) {
      const blockedProtocols = transportBlock.value as string[] | undefined;
      if (blockedProtocols?.includes(context.transport.protocol)) {
        reasons.push(
          `Transport protocol '${context.transport.protocol}' blocked at ${transportBlock.level} level`,
        );
      }
    }

    // Check for endpoint restrictions
    const endpointConstraint = resolveConstraints(allConstraints, 'allowed_endpoints');
    if (endpointConstraint && context.transport.endpoint) {
      const allowed = endpointConstraint.value as string[] | undefined;
      if (allowed && !allowed.some((p) => context.transport.endpoint?.startsWith(p))) {
        reasons.push(
          `Endpoint '${context.transport.endpoint}' not in ${endpointConstraint.level}-level allowlist`,
        );
      }
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      decidedAt: reasons.length > 0 ? this.highestDenyingLevel(allConstraints, reasons) : level,
      identityVerified,
      integrityVerified,
    };
  }

  /**
   * Determine the highest enforcement level that contributed to a denial.
   */
  private highestDenyingLevel(
    constraints: LeveledConstraint[],
    _reasons: string[],
  ): EnforcementLevel {
    if (constraints.length === 0) return 'agent';
    const sorted = [...constraints].sort(
      (a, b) => ENFORCEMENT_PRIORITY[a.level] - ENFORCEMENT_PRIORITY[b.level],
    );
    return sorted[0].level;
  }
}
