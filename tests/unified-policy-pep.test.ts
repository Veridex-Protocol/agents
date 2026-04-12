/**
 * Tests for UnifiedPolicyContext and TransportBoundaryPEP.
 */

import { describe, it, expect } from 'vitest';
import {
  buildUnifiedPolicyContext,
  resolveConstraints,
  isDelegationAllowed,
  ENFORCEMENT_PRIORITY,
} from '../src/policy/UnifiedPolicyContext';
import type {
  EnforcementLevel,
  LeveledConstraint,
  UnifiedPolicyContext,
} from '../src/policy/UnifiedPolicyContext';
import type { PolicyContext } from '../src/policy/PolicyEngine';
import { TransportBoundaryPEP } from '../src/transports/TransportBoundaryPEP';
import type { AgentIdentityClaims, AgentIntegrityBinding } from '../src/types/identity';

// ── Helpers ──

const basePolicyContext: PolicyContext = {
  runId: 'run_1',
  agentId: 'agent_1',
  turnIndex: 0,
  proposal: { type: 'final_answer', text: 'Hello' } as any,
};

const mockIdentity: AgentIdentityClaims = {
  issuer: 'veridex.io',
  subject: 'agent_1',
  name: 'Test Agent',
  version: '1.0.0',
  issuedAt: Date.now(),
  scopes: ['read', 'write'],
  maxDelegationDepth: 3,
};

const mockIntegrity: AgentIntegrityBinding = {
  definitionHash: 'a'.repeat(64),
  toolManifestHash: 'b'.repeat(64),
  agentChecksum: 'c'.repeat(64),
  computedAt: Date.now(),
};

// ── buildUnifiedPolicyContext ──

describe('buildUnifiedPolicyContext', () => {
  it('extends base context with defaults', () => {
    const ctx = buildUnifiedPolicyContext(basePolicyContext);
    expect(ctx.runId).toBe('run_1');
    expect(ctx.enforcementLevel).toBe('agent');
    expect(ctx.delegationDepth).toBe(0);
    expect(ctx.identityClaims).toBeUndefined();
  });

  it('includes identity and integrity when provided', () => {
    const ctx = buildUnifiedPolicyContext(basePolicyContext, {
      identityClaims: mockIdentity,
      integrityBinding: mockIntegrity,
      enforcementLevel: 'tenant',
      tenantId: 'tenant-1',
    });
    expect(ctx.identityClaims?.issuer).toBe('veridex.io');
    expect(ctx.integrityBinding?.agentChecksum).toBe('c'.repeat(64));
    expect(ctx.enforcementLevel).toBe('tenant');
    expect(ctx.tenantId).toBe('tenant-1');
  });

  it('tracks delegation chain depth', () => {
    const ctx = buildUnifiedPolicyContext(basePolicyContext, {
      delegationChain: [
        { fromAgentId: 'root', toAgentId: 'child1', reason: 'handoff', timestamp: 1, depth: 0 },
        { fromAgentId: 'child1', toAgentId: 'child2', reason: 'subagent', timestamp: 2, depth: 1 },
      ],
    });
    expect(ctx.delegationDepth).toBe(2);
    expect(ctx.delegationChain).toHaveLength(2);
  });
});

// ── resolveConstraints ──

describe('resolveConstraints', () => {
  it('returns highest-authority constraint', () => {
    const constraints: LeveledConstraint[] = [
      { level: 'agent', constraintType: 'spending_limit', value: 100 },
      { level: 'tenant', constraintType: 'spending_limit', value: 50 },
      { level: 'platform', constraintType: 'spending_limit', value: 10 },
    ];
    const result = resolveConstraints(constraints, 'spending_limit');
    expect(result?.level).toBe('platform');
    expect(result?.value).toBe(10);
  });

  it('immutable constraint wins over all levels', () => {
    const constraints: LeveledConstraint[] = [
      { level: 'platform', constraintType: 'max_tokens', value: 1000 },
      { level: 'agent', constraintType: 'max_tokens', value: 500, immutable: true },
    ];
    const result = resolveConstraints(constraints, 'max_tokens');
    expect(result?.level).toBe('agent');
    expect(result?.immutable).toBe(true);
  });

  it('returns undefined for missing constraint type', () => {
    const constraints: LeveledConstraint[] = [
      { level: 'tenant', constraintType: 'spending_limit', value: 50 },
    ];
    const result = resolveConstraints(constraints, 'max_tokens');
    expect(result).toBeUndefined();
  });
});

// ── isDelegationAllowed ──

describe('isDelegationAllowed', () => {
  it('allows delegation within bounds', () => {
    const ctx = buildUnifiedPolicyContext(basePolicyContext, {
      identityClaims: { ...mockIdentity, maxDelegationDepth: 3 },
      delegationChain: [
        { fromAgentId: 'a', toAgentId: 'b', reason: 'test', timestamp: 1, depth: 0 },
      ],
    });
    expect(isDelegationAllowed(ctx)).toBe(true);
  });

  it('blocks delegation at max depth', () => {
    const ctx = buildUnifiedPolicyContext(basePolicyContext, {
      identityClaims: { ...mockIdentity, maxDelegationDepth: 1 },
      delegationChain: [
        { fromAgentId: 'a', toAgentId: 'b', reason: 'test', timestamp: 1, depth: 0 },
        { fromAgentId: 'b', toAgentId: 'c', reason: 'test', timestamp: 2, depth: 1 },
      ],
    });
    expect(isDelegationAllowed(ctx)).toBe(false);
  });

  it('allows unlimited delegation when no max set', () => {
    const ctx = buildUnifiedPolicyContext(basePolicyContext, {
      identityClaims: { ...mockIdentity, maxDelegationDepth: undefined },
      delegationChain: Array.from({ length: 100 }, (_, i) => ({
        fromAgentId: `a${i}`,
        toAgentId: `a${i + 1}`,
        reason: 'test',
        timestamp: i,
        depth: i,
      })),
    });
    expect(isDelegationAllowed(ctx)).toBe(true);
  });
});

// ── ENFORCEMENT_PRIORITY ──

describe('ENFORCEMENT_PRIORITY', () => {
  it('platform has highest priority (lowest number)', () => {
    expect(ENFORCEMENT_PRIORITY.platform).toBeLessThan(ENFORCEMENT_PRIORITY.tenant);
    expect(ENFORCEMENT_PRIORITY.tenant).toBeLessThan(ENFORCEMENT_PRIORITY.workspace);
    expect(ENFORCEMENT_PRIORITY.workspace).toBeLessThan(ENFORCEMENT_PRIORITY.agent);
  });
});

// ── TransportBoundaryPEP ──

describe('TransportBoundaryPEP', () => {
  it('allows calls without restrictions', () => {
    const pep = new TransportBoundaryPEP();
    const result = pep.evaluate({
      transport: { protocol: 'http', authenticated: false },
    });
    expect(result.allowed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('blocks when identity is required but missing', () => {
    const pep = new TransportBoundaryPEP({ requireIdentity: true });
    const result = pep.evaluate({
      transport: { protocol: 'http', authenticated: false },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('Identity claims required but not provided');
  });

  it('blocks expired identity', () => {
    const pep = new TransportBoundaryPEP();
    const result = pep.evaluate({
      callerIdentity: { ...mockIdentity, expiresAt: Date.now() - 60_000 },
      transport: { protocol: 'mcp', authenticated: true },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('Agent identity has expired');
  });

  it('blocks untrusted issuers', () => {
    const pep = new TransportBoundaryPEP({
      trustedIssuers: ['veridex.io', 'trusted-corp.com'],
    });
    const result = pep.evaluate({
      callerIdentity: { ...mockIdentity, issuer: 'malicious.io' },
      transport: { protocol: 'acp', authenticated: true },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toContain("Issuer 'malicious.io' is not trusted");
  });

  it('blocks missing required scopes', () => {
    const pep = new TransportBoundaryPEP({
      requiredScopes: ['read', 'write', 'admin'],
    });
    const result = pep.evaluate({
      callerIdentity: mockIdentity, // has read, write but not admin
      transport: { protocol: 'mcp', authenticated: true },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toContain('Missing required scopes: admin');
  });

  it('blocks when integrity required but missing', () => {
    const pep = new TransportBoundaryPEP({ requireIntegrity: true });
    const result = pep.evaluate({
      callerIdentity: mockIdentity,
      transport: { protocol: 'http', authenticated: true },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('Integrity binding required but not provided');
  });

  it('passes with valid identity + integrity', () => {
    const pep = new TransportBoundaryPEP({
      requireIdentity: true,
      requireIntegrity: true,
      trustedIssuers: ['veridex.io'],
      requiredScopes: ['read'],
    });
    const result = pep.evaluate({
      callerIdentity: mockIdentity,
      callerIntegrity: mockIntegrity,
      transport: { protocol: 'mcp', authenticated: true },
    });
    expect(result.allowed).toBe(true);
    expect(result.identityVerified).toBe(true);
    expect(result.integrityVerified).toBe(true);
  });

  it('blocks excessive delegation depth', () => {
    const pep = new TransportBoundaryPEP({ maxDelegationDepth: 2 });
    const result = pep.evaluate({
      callerIdentity: mockIdentity,
      delegationDepth: 5,
      transport: { protocol: 'a2a', authenticated: true },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toContain('Delegation depth 5 exceeds maximum 2');
  });

  it('enforces platform-level transport blocks', () => {
    const pep = new TransportBoundaryPEP({
      platformConstraints: [
        { level: 'platform', constraintType: 'block_transport', value: ['http'], immutable: true },
      ],
    });
    const result = pep.evaluate({
      transport: { protocol: 'http', authenticated: false },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toContain("Transport protocol 'http' blocked at platform level");
  });

  it('enforces endpoint allowlist constraints', () => {
    const pep = new TransportBoundaryPEP({
      platformConstraints: [
        {
          level: 'tenant',
          constraintType: 'allowed_endpoints',
          value: ['https://api.veridex.io'],
        },
      ],
    });
    const result = pep.evaluate({
      transport: { protocol: 'http', endpoint: 'https://evil.com/api', authenticated: true },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toContain('not in tenant-level allowlist');
  });
});
