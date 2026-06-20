/**
 * DelegationGuard tests — cross-agent confused-deputy enforcement.
 *
 * Verifies cryptographic mandate verification, monotonic scope attenuation,
 * delegation-depth limits, and fail-closed authorization at the boundary where
 * Agent A delegates to Agent B.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMandateCredential,
  RevocationRegistry,
  type MandateCredential,
  type MandateCredentialSubject,
} from '../src/credentials/MandateCredential';
import {
  DelegationGuard,
  HmacMandateSigner,
  attenuateMandate,
  signMandate,
  verifyMandateSignature,
  DelegationError,
} from '../src/credentials/DelegationGuard';

const SECRET = 'test-mandate-secret';

function parentSubject(overrides: Partial<MandateCredentialSubject> = {}): MandateCredentialSubject {
  return {
    agentId: 'agent-A',
    principalId: 'principal-1',
    spendingLimits: { maxAmountUSD: 100, perTransaction: 50 },
    actionConstraints: { allowedTools: ['search', 'pay'], allowedChains: ['eip155:1'] },
    delegation: {
      delegatorAgentId: 'principal-1',
      delegateAgentId: 'agent-A',
      depth: 0,
      maxDepth: 2,
      purpose: 'root',
    },
    ...overrides,
  };
}

async function buildSignedParent(
  signer: HmacMandateSigner,
  opts: { subject?: MandateCredentialSubject; statusListIndex?: number; expirationDate?: string } = {},
): Promise<MandateCredential> {
  const unsigned = buildMandateCredential({
    id: 'urn:uuid:parent',
    issuer: 'did:veridex:issuer',
    subject: opts.subject ?? parentSubject(),
    expirationDate: opts.expirationDate,
    statusListCredential:
      opts.statusListIndex !== undefined ? 'https://veridex/status/1' : undefined,
    statusListIndex: opts.statusListIndex,
  });
  return signMandate(unsigned, signer);
}

describe('HmacMandateSigner', () => {
  it('signs and verifies a payload, rejecting tampering', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const proof = await signer.sign('hello');
    expect(proof).toMatch(/^[0-9a-f]+$/);
    expect(await signer.verify('hello', proof, signer.verificationMethod)).toBe(true);
    expect(await signer.verify('hello!', proof, signer.verificationMethod)).toBe(false);
  });
});

describe('signMandate / verifyMandateSignature', () => {
  it('round-trips a signed mandate', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const mandate = await buildSignedParent(signer);
    expect(mandate.proof).toBeDefined();
    expect(await verifyMandateSignature(mandate, signer)).toBe(true);
  });

  it('detects tampering with the credential subject after signing', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const mandate = await buildSignedParent(signer);
    const tampered: MandateCredential = {
      ...mandate,
      credentialSubject: {
        ...mandate.credentialSubject,
        spendingLimits: { maxAmountUSD: 1_000_000 },
      },
    };
    expect(await verifyMandateSignature(tampered, signer)).toBe(false);
  });

  it('returns false for an unsigned mandate', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const unsigned = buildMandateCredential({
      id: 'x',
      issuer: 'did:veridex:issuer',
      subject: parentSubject(),
    });
    expect(await verifyMandateSignature(unsigned, signer)).toBe(false);
  });
});

describe('attenuateMandate', () => {
  const base = () =>
    buildMandateCredential({ id: 'p', issuer: 'i', subject: parentSubject() });

  it('narrows spend, intersects tools, and increments depth', () => {
    const child = attenuateMandate({
      parent: base(),
      delegateAgentId: 'agent-B',
      purpose: 'subtask',
      childMandateId: 'urn:uuid:child',
      issuer: 'did:veridex:issuer',
      requestedScope: {
        spendingLimits: { maxAmountUSD: 30 },
        actionConstraints: { allowedTools: ['search'] },
      },
    });
    expect(child.credentialSubject.spendingLimits.maxAmountUSD).toBe(30);
    expect(child.credentialSubject.actionConstraints.allowedTools).toEqual(['search']);
    expect(child.credentialSubject.delegation?.depth).toBe(1);
    expect(child.credentialSubject.delegation?.delegatorAgentId).toBe('agent-A');
    expect(child.credentialSubject.delegation?.delegateAgentId).toBe('agent-B');
    // Principal is preserved down the chain.
    expect(child.credentialSubject.principalId).toBe('principal-1');
  });

  it('caps child spend at the parent even when a higher amount is requested', () => {
    const child = attenuateMandate({
      parent: base(),
      delegateAgentId: 'agent-B',
      purpose: 'subtask',
      childMandateId: 'c',
      issuer: 'i',
      requestedScope: { spendingLimits: { maxAmountUSD: 10_000 } },
    });
    expect(child.credentialSubject.spendingLimits.maxAmountUSD).toBe(100);
  });

  it('throws on a tool escalation attempt', () => {
    expect(() =>
      attenuateMandate({
        parent: base(),
        delegateAgentId: 'agent-B',
        purpose: 'subtask',
        childMandateId: 'c',
        issuer: 'i',
        requestedScope: { actionConstraints: { allowedTools: ['transfer_all'] } },
      }),
    ).toThrow(DelegationError);
  });

  it('throws when depth would exceed maxDepth', () => {
    const deepParent = buildMandateCredential({
      id: 'p',
      issuer: 'i',
      subject: parentSubject({
        delegation: {
          delegatorAgentId: 'x',
          delegateAgentId: 'agent-A',
          depth: 2,
          maxDepth: 2,
          purpose: 'root',
        },
      }),
    });
    expect(() =>
      attenuateMandate({
        parent: deepParent,
        delegateAgentId: 'agent-B',
        purpose: 'subtask',
        childMandateId: 'c',
        issuer: 'i',
      }),
    ).toThrow(/depth/i);
  });

  it('never lets the child outlive the parent', () => {
    const soon = new Date(Date.now() + 1000).toISOString();
    const parent = buildMandateCredential({
      id: 'p',
      issuer: 'i',
      subject: parentSubject(),
      expirationDate: soon,
    });
    const child = attenuateMandate({
      parent,
      delegateAgentId: 'agent-B',
      purpose: 'subtask',
      childMandateId: 'c',
      issuer: 'i',
      ttlMs: 60 * 60 * 1000, // request a much longer TTL
    });
    expect(new Date(child.expirationDate!).getTime()).toBeLessThanOrEqual(
      new Date(soon).getTime(),
    );
  });
});

describe('DelegationGuard.authorizeDelegation', () => {
  const baseRequest = {
    delegateAgentId: 'agent-B',
    purpose: 'subtask',
    childMandateId: 'urn:uuid:child',
    issuer: 'did:veridex:issuer',
  };

  it('authorizes a valid delegation and issues a signed, verifiable child mandate', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const guard = new DelegationGuard({ signer, verifier: signer });
    const parentMandate = await buildSignedParent(signer);

    const decision = await guard.authorizeDelegation({
      ...baseRequest,
      parentMandate,
      requestedScope: { spendingLimits: { maxAmountUSD: 20 }, actionConstraints: { allowedTools: ['search'] } },
      action: { toolName: 'search', proposedAmountUSD: 10 },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.childMandate).toBeDefined();
    expect(decision.childMandate!.credentialSubject.spendingLimits.maxAmountUSD).toBe(20);
    expect(await verifyMandateSignature(decision.childMandate!, signer)).toBe(true);
  });

  it('denies delegation when the parent mandate signature is invalid', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const guard = new DelegationGuard({ signer, verifier: signer });
    const parentMandate = await buildSignedParent(signer);
    // Tamper after signing.
    parentMandate.credentialSubject.spendingLimits.maxAmountUSD = 999_999;

    const decision = await guard.authorizeDelegation({ ...baseRequest, parentMandate });
    expect(decision.allowed).toBe(false);
    expect(decision.childMandate).toBeUndefined();
    expect(decision.reasons.join(' ')).toMatch(/signature/i);
  });

  it('denies delegation when the parent mandate is revoked', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const registry = new RevocationRegistry();
    await registry.revoke(7);
    const guard = new DelegationGuard({ signer, verifier: signer, registry });
    const parentMandate = await buildSignedParent(signer, { statusListIndex: 7 });

    const decision = await guard.authorizeDelegation({ ...baseRequest, parentMandate });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/revoked/i);
  });

  it('denies delegation that exceeds the parent spend for the action', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const guard = new DelegationGuard({ signer, verifier: signer });
    const parentMandate = await buildSignedParent(signer);

    const decision = await guard.authorizeDelegation({
      ...baseRequest,
      parentMandate,
      action: { proposedAmountUSD: 500 }, // parent max is 100
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/exceeds/i);
  });

  it('denies a tool-escalation delegation (confused-deputy attempt)', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const guard = new DelegationGuard({ signer, verifier: signer });
    const parentMandate = await buildSignedParent(signer);

    const decision = await guard.authorizeDelegation({
      ...baseRequest,
      parentMandate,
      requestedScope: { actionConstraints: { allowedTools: ['drain_treasury'] } },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/outside the parent mandate/i);
  });

  it('denies re-delegation past the depth ceiling', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const guard = new DelegationGuard({ signer, verifier: signer });
    const parentMandate = await buildSignedParent(signer, {
      subject: parentSubject({
        delegation: {
          delegatorAgentId: 'x',
          delegateAgentId: 'agent-A',
          depth: 2,
          maxDepth: 2,
          purpose: 'root',
        },
      }),
    });

    const decision = await guard.authorizeDelegation({ ...baseRequest, parentMandate });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/depth/i);
  });
});
