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
 * Persistence adapter for the revocation registry.
 *
 * Implementations are expected to be backed by durable storage (Postgres via
 * Prisma, Redis, Cloud KV, etc.). All methods are async so the registry stays
 * correct under multi-instance deploys: revocations survive restarts and
 * propagate across relayer replicas.
 *
 * The default `InMemoryRevocationStore` is provided for tests and local dev.
 * Production deployments MUST override this with a persistent implementation.
 */
export interface RevocationStore {
  /** Load the full revoked / suspended set (called once at startup). */
  hydrate(): Promise<{ revoked: number[]; suspended: number[] }>;
  /** Persist a revocation. Must be durable before resolving. */
  persistRevoke(index: number, reason?: string): Promise<void>;
  /** Persist a suspension. */
  persistSuspend(index: number, reason?: string): Promise<void>;
  /** Persist a reinstatement. */
  persistReinstate(index: number): Promise<void>;
}

/** Broadcast channel used to fan out revocation events across instances. */
export interface RevocationBroadcaster {
  /** Publish an event so peer instances can update their in-memory mirrors. */
  publish(event: RevocationEvent): Promise<void>;
  /** Subscribe to peer events; the callback updates local in-memory state. */
  subscribe(handler: (event: RevocationEvent) => void): () => void;
}

export type RevocationEvent =
  | { kind: 'revoke'; index: number; reason?: string }
  | { kind: 'suspend'; index: number; reason?: string }
  | { kind: 'reinstate'; index: number };

/** Default in-memory store — suitable for tests and single-process dev only. */
export class InMemoryRevocationStore implements RevocationStore {
  private readonly revoked = new Set<number>();
  private readonly suspended = new Set<number>();
  async hydrate(): Promise<{ revoked: number[]; suspended: number[] }> {
    return { revoked: [...this.revoked], suspended: [...this.suspended] };
  }
  async persistRevoke(index: number): Promise<void> {
    this.revoked.add(index);
    this.suspended.delete(index);
  }
  async persistSuspend(index: number): Promise<void> {
    this.suspended.add(index);
  }
  async persistReinstate(index: number): Promise<void> {
    this.suspended.delete(index);
  }
}

/**
 * StatusList2021 revocation registry with pluggable persistence.
 *
 * Behaviour:
 * - All queries (`isRevoked`, `isSuspended`, `isActive`) are served from the
 *   in-memory mirror so the hot path stays O(1) with zero I/O.
 * - All mutations (`revoke`, `suspend`, `reinstate`) are persisted via the
 *   configured `RevocationStore` and then broadcast so peer instances can
 *   update their mirrors. If persistence fails the mirror is NOT updated
 *   (fail-closed: the caller sees an error, the state stays consistent).
 *
 * For backward compatibility the parameter-less constructor keeps the old
 * in-memory-only semantics; callers must explicitly opt into persistence.
 */
export class RevocationRegistry {
  private readonly revoked = new Set<number>();
  private readonly suspended = new Set<number>();
  private readonly store: RevocationStore;
  private readonly broadcaster?: RevocationBroadcaster;
  private unsubscribe?: () => void;
  private hydrated = false;

  constructor(options: { store?: RevocationStore; broadcaster?: RevocationBroadcaster } = {}) {
    this.store = options.store ?? new InMemoryRevocationStore();
    this.broadcaster = options.broadcaster;

    if (this.broadcaster) {
      this.unsubscribe = this.broadcaster.subscribe((event) => this.applyRemote(event));
    }
  }

  /** Load persisted state. Safe to call multiple times — subsequent calls are no-ops. */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const { revoked, suspended } = await this.store.hydrate();
    for (const i of revoked) this.revoked.add(i);
    for (const i of suspended) this.suspended.add(i);
    this.hydrated = true;
  }

  /** Detach the broadcaster subscription (call on shutdown). */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Revoke a credential by its status list index. Throws if persistence fails. */
  async revoke(index: number, reason?: string): Promise<void> {
    await this.store.persistRevoke(index, reason);
    this.revoked.add(index);
    this.suspended.delete(index);
    await this.broadcaster?.publish({ kind: 'revoke', index, reason });
  }

  /** Suspend a credential (reversible). */
  async suspend(index: number, reason?: string): Promise<void> {
    await this.store.persistSuspend(index, reason);
    this.suspended.add(index);
    await this.broadcaster?.publish({ kind: 'suspend', index, reason });
  }

  /** Reinstate a suspended credential. */
  async reinstate(index: number): Promise<void> {
    await this.store.persistReinstate(index);
    this.suspended.delete(index);
    await this.broadcaster?.publish({ kind: 'reinstate', index });
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

  /** Apply a remote event without re-persisting or re-broadcasting. */
  private applyRemote(event: RevocationEvent): void {
    switch (event.kind) {
      case 'revoke':
        this.revoked.add(event.index);
        this.suspended.delete(event.index);
        break;
      case 'suspend':
        this.suspended.add(event.index);
        break;
      case 'reinstate':
        this.suspended.delete(event.index);
        break;
    }
  }
}
