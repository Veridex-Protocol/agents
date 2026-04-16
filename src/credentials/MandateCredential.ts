/**
 * @module credentials
 * @description
 * W3C Verifiable Credential types and utilities for agent mandate credentials.
 *
 * Implements:
 * - MandateCredential: A W3C VC representing a delegated spending/action mandate
 * - RevocationRegistry: In-memory VC revocation status tracking (StatusList2021)
 * - Credential builder + verifier helpers
 *
 * @see ADR-0045 — Phase 2: W3C VC Mandates
 * @see https://www.w3.org/TR/vc-data-model-2.0/
 */

// ── W3C VC Base Types ──

/** W3C Verifiable Credential proof (simplified). */
export interface VCProof {
  type: string;
  created: string;
  verificationMethod: string;
  proofPurpose: string;
  /** Hex-encoded signature */
  proofValue: string;
}

/** W3C Verifiable Credential base structure. */
export interface VerifiableCredential {
  '@context': string[];
  id: string;
  type: string[];
  issuer: string;
  issuanceDate: string;
  expirationDate?: string;
  credentialSubject: Record<string, unknown>;
  credentialStatus?: CredentialStatus;
  proof?: VCProof;
}

/** W3C Status List 2021 reference. */
export interface CredentialStatus {
  id: string;
  type: 'StatusList2021Entry';
  statusPurpose: 'revocation' | 'suspension';
  statusListIndex: number;
  statusListCredential: string;
}

// ── Mandate Credential ──

/** Spending constraint for a mandate. */
export interface MandateSpendingLimit {
  maxAmountUSD: number;
  currency?: string;
  perTransaction?: number;
  perDay?: number;
}

/** Action constraint for a mandate. */
export interface MandateActionConstraint {
  allowedTools?: string[];
  blockedTools?: string[];
  allowedChains?: string[];
  allowedEndpoints?: string[];
  requireIntentVerification?: boolean;
}

/** Delegation detail within the mandate. */
export interface MandateDelegation {
  delegatorAgentId: string;
  delegateAgentId: string;
  depth: number;
  maxDepth: number;
  purpose: string;
}

/** Mandate credential subject. */
export interface MandateCredentialSubject {
  /** Agent receiving the mandate */
  agentId: string;
  /** Human or system principal that issued the mandate */
  principalId: string;
  /** Spending limits */
  spendingLimits: MandateSpendingLimit;
  /** Action constraints */
  actionConstraints: MandateActionConstraint;
  /** Delegation chain (if delegated) */
  delegation?: MandateDelegation;
  /** Intent description for NLI verification */
  declaredIntent?: string;
}

/** A W3C VC specialised as a Mandate Credential. */
export interface MandateCredential extends Omit<VerifiableCredential, 'type' | 'credentialSubject'> {
  type: ['VerifiableCredential', 'MandateCredential'];
  credentialSubject: MandateCredentialSubject;
}

// ── Credential Builder ──

export interface BuildMandateParams {
  id: string;
  issuer: string;
  subject: MandateCredentialSubject;
  issuanceDate?: string;
  expirationDate?: string;
  statusListCredential?: string;
  statusListIndex?: number;
}

/**
 * Build an unsigned MandateCredential.
 * Signing is left to the caller (supports any signature scheme).
 */
export function buildMandateCredential(params: BuildMandateParams): MandateCredential {
  const credential: MandateCredential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://relayer.veridex.network/credentials/mandate/v1',
    ],
    id: params.id,
    type: ['VerifiableCredential', 'MandateCredential'],
    issuer: params.issuer,
    issuanceDate: params.issuanceDate ?? new Date().toISOString(),
    credentialSubject: params.subject,
  };

  if (params.expirationDate) {
    credential.expirationDate = params.expirationDate;
  }

  if (params.statusListCredential && params.statusListIndex !== undefined) {
    credential.credentialStatus = {
      id: `${params.statusListCredential}#${params.statusListIndex}`,
      type: 'StatusList2021Entry',
      statusPurpose: 'revocation',
      statusListIndex: params.statusListIndex,
      statusListCredential: params.statusListCredential,
    };
  }

  return credential;
}

// ── Credential Verification ──

export interface MandateVerificationResult {
  valid: boolean;
  reasons: string[];
  expired: boolean;
  revoked: boolean;
  spendingExceeded: boolean;
  constraintViolations: string[];
}

/**
 * Verify a mandate credential against current context.
 * Validates: proof presence, expiration, revocation, spending, constraints.
 */
export function verifyMandateCredential(
  credential: MandateCredential,
  context: {
    currentSpendUSD?: number;
    proposedAmountUSD?: number;
    toolName?: string;
    chain?: string;
    endpoint?: string;
    registry?: RevocationRegistry;
  },
): MandateVerificationResult {
  const reasons: string[] = [];
  const constraintViolations: string[] = [];
  let expired = false;
  let revoked = false;
  let spendingExceeded = false;

  // VDX-AUTH-008: Require cryptographic proof
  if (!credential.proof) {
    reasons.push('Missing cryptographic proof — credential cannot be trusted');
    return { valid: false, reasons, expired, revoked, spendingExceeded, constraintViolations };
  }

  // Validate proof structure
  const proof = credential.proof;
  if (!proof.type || !proof.verificationMethod || !proof.proofValue) {
    reasons.push('Incomplete proof — missing type, verificationMethod, or proofValue');
    return { valid: false, reasons, expired, revoked, spendingExceeded, constraintViolations };
  }

  // Check expiration
  if (credential.expirationDate) {
    const expiry = new Date(credential.expirationDate).getTime();
    if (Date.now() > expiry) {
      expired = true;
      reasons.push('Mandate credential has expired');
    }
  }

  // Check revocation
  if (context.registry && credential.credentialStatus) {
    const isRevoked = context.registry.isRevoked(credential.credentialStatus.statusListIndex);
    if (isRevoked) {
      revoked = true;
      reasons.push('Mandate credential has been revoked');
    }
  }

  const subject = credential.credentialSubject;

  // Check spending limits
  if (context.proposedAmountUSD !== undefined) {
    const limit = subject.spendingLimits;
    if (context.proposedAmountUSD > limit.maxAmountUSD) {
      spendingExceeded = true;
      reasons.push(`Proposed $${context.proposedAmountUSD} exceeds mandate max $${limit.maxAmountUSD}`);
    }
    if (limit.perTransaction !== undefined && context.proposedAmountUSD > limit.perTransaction) {
      spendingExceeded = true;
      reasons.push(`Proposed $${context.proposedAmountUSD} exceeds per-transaction limit $${limit.perTransaction}`);
    }
  }

  // Check action constraints
  const constraints = subject.actionConstraints;
  if (context.toolName) {
    if (constraints.allowedTools && constraints.allowedTools.length > 0) {
      if (!constraints.allowedTools.includes(context.toolName)) {
        constraintViolations.push(`Tool '${context.toolName}' not in allowed list`);
      }
    }
    if (constraints.blockedTools && constraints.blockedTools.includes(context.toolName)) {
      constraintViolations.push(`Tool '${context.toolName}' is explicitly blocked`);
    }
  }

  if (context.chain && constraints.allowedChains && constraints.allowedChains.length > 0) {
    if (!constraints.allowedChains.includes(context.chain)) {
      constraintViolations.push(`Chain '${context.chain}' not in allowed list`);
    }
  }

  if (context.endpoint && constraints.allowedEndpoints && constraints.allowedEndpoints.length > 0) {
    if (!constraints.allowedEndpoints.includes(context.endpoint)) {
      constraintViolations.push(`Endpoint '${context.endpoint}' not in allowed list`);
    }
  }

  reasons.push(...constraintViolations);

  return {
    valid: reasons.length === 0,
    reasons,
    expired,
    revoked,
    spendingExceeded,
    constraintViolations,
  };
}

// ── Revocation Registry ──

/**
 * In-memory StatusList2021 revocation registry.
 * Tracks which credential indices have been revoked.
 *
 * Production implementations should back this with persistent storage.
 */
export class RevocationRegistry {
  private readonly revoked = new Set<number>();
  private readonly suspended = new Set<number>();

  /** Revoke a credential by its status list index. */
  revoke(index: number): void {
    this.revoked.add(index);
  }

  /** Suspend a credential (reversible). */
  suspend(index: number): void {
    this.suspended.add(index);
  }

  /** Reinstate a suspended credential. */
  reinstate(index: number): void {
    this.suspended.delete(index);
  }

  /** Check if a credential is revoked (permanent). */
  isRevoked(index: number): boolean {
    return this.revoked.has(index);
  }

  /** Check if a credential is suspended (temporary). */
  isSuspended(index: number): boolean {
    return this.suspended.has(index);
  }

  /** Check if a credential is active (not revoked or suspended). */
  isActive(index: number): boolean {
    return !this.revoked.has(index) && !this.suspended.has(index);
  }

  /** Get all revoked indices. */
  getRevokedIndices(): number[] {
    return [...this.revoked];
  }

  /** Get all suspended indices. */
  getSuspendedIndices(): number[] {
    return [...this.suspended];
  }

  /** Total number of revoked + suspended credentials. */
  get size(): number {
    return this.revoked.size + this.suspended.size;
  }
}
