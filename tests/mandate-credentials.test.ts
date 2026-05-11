/**
 * Tests for Phase 2: W3C VC Mandate Credentials & Revocation Registry
 */
import { describe, it, expect } from 'vitest';
import {
  buildMandateCredential,
  verifyMandateCredential,
  RevocationRegistry,
} from '../src';
import type { MandateCredential, MandateCredentialSubject } from '../src';

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

/** Attach a stub proof so the credential passes the cryptographic-proof gate. */
function withStubProof(vc: MandateCredential): MandateCredential {
  return {
    ...vc,
    proof: {
      type: 'Ed25519Signature2020',
      created: new Date().toISOString(),
      verificationMethod: 'did:veridex:alice#key-1',
      proofPurpose: 'assertionMethod',
      proofValue: 'z' + 'a'.repeat(86),
    },
  };
}

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
  const vc = withStubProof(
    buildMandateCredential({
      id: 'urn:veridex:mandate:test',
      issuer: 'did:veridex:alice',
      subject: baseSubject,
      expirationDate: '2099-01-01T00:00:00Z',
      statusListCredential: 'https://veridex.io/status/1',
      statusListIndex: 5,
    }),
  );

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
    const expired = withStubProof(
      buildMandateCredential({
        id: 'urn:veridex:mandate:expired',
        issuer: 'did:veridex:alice',
        subject: baseSubject,
        expirationDate: '2020-01-01T00:00:00Z',
      }),
    );
    const result = verifyMandateCredential(expired, {});
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(true);
  });

  it('detects revoked credential', async () => {
    const registry = new RevocationRegistry();
    await registry.revoke(5);
    const result = verifyMandateCredential(vc, { registry });
    expect(result.valid).toBe(false);
    expect(result.revoked).toBe(true);
  });
});

describe('RevocationRegistry', () => {
  it('revokes and checks', async () => {
    const reg = new RevocationRegistry();
    expect(reg.isRevoked(1)).toBe(false);
    await reg.revoke(1);
    expect(reg.isRevoked(1)).toBe(true);
    expect(reg.isActive(1)).toBe(false);
  });

  it('suspends and reinstates', async () => {
    const reg = new RevocationRegistry();
    await reg.suspend(2);
    expect(reg.isSuspended(2)).toBe(true);
    expect(reg.isActive(2)).toBe(false);
    await reg.reinstate(2);
    expect(reg.isSuspended(2)).toBe(false);
    expect(reg.isActive(2)).toBe(true);
  });

  it('tracks size', async () => {
    const reg = new RevocationRegistry();
    await reg.revoke(1);
    await reg.suspend(2);
    expect(reg.size).toBe(2);
  });

  it('lists indices', async () => {
    const reg = new RevocationRegistry();
    await reg.revoke(10);
    await reg.revoke(20);
    await reg.suspend(30);
    expect(reg.getRevokedIndices()).toEqual([10, 20]);
    expect(reg.getSuspendedIndices()).toEqual([30]);
  });
});
