/**
 * Tests for Phase 2: W3C VC Mandate Credentials & Revocation Registry
 */
import { describe, it, expect } from 'vitest';
import {
  buildMandateCredential,
  verifyMandateCredential,
  RevocationRegistry,
} from '../src';
import type { MandateCredentialSubject } from '../src';

const baseSubject: MandateCredentialSubject = {
  agentId: 'agent-shopping-bot',
  principalId: 'user:alice',
  spendingLimits: {
    maxAmountUSD: 100,
    perTransaction: 25,
  },
  actionConstraints: {
    allowedTools: ['payment', 'lookup'],
    blockedTools: ['admin_delete'],
    allowedChains: ['ethereum', 'base'],
  },
};

describe('buildMandateCredential', () => {
  it('builds a valid VC structure', () => {
    const vc = buildMandateCredential({
      id: 'urn:veridex:mandate:001',
      issuer: 'did:veridex:alice',
      subject: baseSubject,
    });
    expect(vc['@context']).toContain('https://www.w3.org/2018/credentials/v1');
    expect(vc.type).toEqual(['VerifiableCredential', 'MandateCredential']);
    expect(vc.issuer).toBe('did:veridex:alice');
    expect(vc.credentialSubject.agentId).toBe('agent-shopping-bot');
    expect(vc.issuanceDate).toBeDefined();
  });

  it('includes expiration when provided', () => {
    const vc = buildMandateCredential({
      id: 'urn:veridex:mandate:002',
      issuer: 'did:veridex:alice',
      subject: baseSubject,
      expirationDate: '2027-01-01T00:00:00Z',
    });
    expect(vc.expirationDate).toBe('2027-01-01T00:00:00Z');
  });

  it('includes status list when provided', () => {
    const vc = buildMandateCredential({
      id: 'urn:veridex:mandate:003',
      issuer: 'did:veridex:alice',
      subject: baseSubject,
      statusListCredential: 'https://veridex.io/status/1',
      statusListIndex: 42,
    });
    expect(vc.credentialStatus).toBeDefined();
    expect(vc.credentialStatus!.type).toBe('StatusList2021Entry');
    expect(vc.credentialStatus!.statusListIndex).toBe(42);
  });
});

describe('verifyMandateCredential', () => {
  const vc = buildMandateCredential({
    id: 'urn:veridex:mandate:test',
    issuer: 'did:veridex:alice',
    subject: baseSubject,
    expirationDate: '2099-01-01T00:00:00Z',
    statusListCredential: 'https://veridex.io/status/1',
    statusListIndex: 5,
  });

  it('passes for valid context', () => {
    const result = verifyMandateCredential(vc, {
      proposedAmountUSD: 10,
      toolName: 'payment',
      chain: 'ethereum',
    });
    expect(result.valid).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('detects spending over max', () => {
    const result = verifyMandateCredential(vc, {
      proposedAmountUSD: 200,
    });
    expect(result.valid).toBe(false);
    expect(result.spendingExceeded).toBe(true);
  });

  it('detects per-transaction limit breach', () => {
    const result = verifyMandateCredential(vc, {
      proposedAmountUSD: 30,
    });
    expect(result.valid).toBe(false);
    expect(result.spendingExceeded).toBe(true);
  });

  it('detects disallowed tool', () => {
    const result = verifyMandateCredential(vc, {
      toolName: 'admin_delete',
    });
    expect(result.valid).toBe(false);
    expect(result.constraintViolations).toContain("Tool 'admin_delete' is explicitly blocked");
  });

  it('detects tool not in allowed list', () => {
    const result = verifyMandateCredential(vc, {
      toolName: 'unknown_tool',
    });
    expect(result.valid).toBe(false);
    expect(result.constraintViolations.some((v) => v.includes('not in allowed list'))).toBe(true);
  });

  it('detects disallowed chain', () => {
    const result = verifyMandateCredential(vc, {
      chain: 'solana',
    });
    expect(result.valid).toBe(false);
  });

  it('detects expired credential', () => {
    const expired = buildMandateCredential({
      id: 'urn:veridex:mandate:expired',
      issuer: 'did:veridex:alice',
      subject: baseSubject,
      expirationDate: '2020-01-01T00:00:00Z',
    });
    const result = verifyMandateCredential(expired, {});
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(true);
  });

  it('detects revoked credential', () => {
    const registry = new RevocationRegistry();
    registry.revoke(5);
    const result = verifyMandateCredential(vc, { registry });
    expect(result.valid).toBe(false);
    expect(result.revoked).toBe(true);
  });
});

describe('RevocationRegistry', () => {
  it('revokes and checks', () => {
    const reg = new RevocationRegistry();
    expect(reg.isRevoked(1)).toBe(false);
    reg.revoke(1);
    expect(reg.isRevoked(1)).toBe(true);
    expect(reg.isActive(1)).toBe(false);
  });

  it('suspends and reinstates', () => {
    const reg = new RevocationRegistry();
    reg.suspend(2);
    expect(reg.isSuspended(2)).toBe(true);
    expect(reg.isActive(2)).toBe(false);
    reg.reinstate(2);
    expect(reg.isSuspended(2)).toBe(false);
    expect(reg.isActive(2)).toBe(true);
  });

  it('tracks size', () => {
    const reg = new RevocationRegistry();
    reg.revoke(1);
    reg.suspend(2);
    expect(reg.size).toBe(2);
  });

  it('lists indices', () => {
    const reg = new RevocationRegistry();
    reg.revoke(10);
    reg.revoke(20);
    reg.suspend(30);
    expect(reg.getRevokedIndices()).toEqual([10, 20]);
    expect(reg.getSuspendedIndices()).toEqual([30]);
  });
});
