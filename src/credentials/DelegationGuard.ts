/**
 * @module credentials/DelegationGuard
 * @description
 * Closes the **cross-agent "confused deputy"** gap (agent_fabric_gap_analysis.md, Gap 2).
 *
 * When Agent A delegates a task to Agent B, B must not be able to act beyond the
 * authority A was itself granted and a compromised A (e.g. via prompt
 * injection) must not be able to mint authority out of thin air or re-delegate
 * without bound. {@link MandateCredential} already models a scoped, signed
 * mandate, but nothing verified or *attenuated* it at the delegation boundary.
 *
 * `DelegationGuard` is that boundary. On every delegation it:
 *
 * 1. **Cryptographically verifies** the parent mandate's signature. The existing
 *    {@link verifyMandateCredential} only checks proof *structure*; here the
 *    `proofValue` is actually verified against the issuer key via a pluggable
 *    {@link MandateVerifier}. A forged or tampered mandate is rejected.
 * 2. **Validates** the parent mandate for the action being delegated (expiry,
 *    revocation, spend, tool/chain/endpoint constraints).
 * 3. **Enforces delegation depth** a child can never exceed the parent's
 *    `maxDepth`, preventing unbounded re-delegation chains.
 * 4. **Attenuates scope monotonically** the child mandate's spend limits and
 *    tool/chain/endpoint allow-lists are the *intersection* with the parent's.
 *    A delegation that tries to broaden authority is denied, not silently
 *    widened.
 * 5. **Issues a freshly signed, short-lived child mandate** bound to the
 *    delegate agent, that never outlives the parent.
 *
 * The guard is **fail-closed**: if any step cannot be completed, delegation is
 * denied and no child mandate is produced.
 *
 * @see ADR-0045 Phase 2: W3C VC Mandates
 */

import { canonicalJSON } from '../models/integrity';
import {
  buildMandateCredential,
  verifyMandateCredential,
  type MandateCredential,
  type MandateCredentialSubject,
  type MandateSpendingLimit,
  type MandateActionConstraint,
  type RevocationRegistry,
} from './MandateCredential';

// ── Signing / verification interfaces (pluggable crypto) ──

/**
 * Produces a detached proof over a mandate's canonical bytes. Implementations
 * wrap a concrete scheme (Ed25519/KMS in production, HMAC for tests/dev).
 */
export interface MandateSigner {
  /** `proof.type` written onto issued credentials (e.g. `Ed25519Signature2020`). */
  readonly proofType: string;
  /** `proof.verificationMethod` — a DID/key URL the verifier resolves. */
  readonly verificationMethod: string;
  /** Sign the canonical payload, returning a hex-encoded `proofValue`. */
  sign(payload: string): Promise<string>;
}

/** Verifies a detached mandate proof against the issuer key material. */
export interface MandateVerifier {
  verify(payload: string, proofValue: string, verificationMethod: string): Promise<boolean>;
}

// ── Default HMAC signer/verifier (dependency-free, symmetric) ──

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time string compare to avoid leaking match length via timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Symmetric HMAC-SHA-256 signer/verifier over the Web Crypto API. Suitable for
 * a single trust domain (the relayer issues and verifies its own mandates) and
 * for tests. For cross-organisation delegation use an asymmetric implementation
 * (Ed25519/KMS) so verifiers never hold signing keys.
 */
export class HmacMandateSigner implements MandateSigner, MandateVerifier {
  readonly proofType = 'HmacSha256Mandate2024';
  readonly verificationMethod: string;
  private readonly keyPromise: Promise<CryptoKey>;

  constructor(secret: string, verificationMethod = 'veridex:hmac:default') {
    this.verificationMethod = verificationMethod;
    this.keyPromise = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }

  async sign(payload: string): Promise<string> {
    const key = await this.keyPromise;
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    return toHex(sig);
  }

  async verify(payload: string, proofValue: string, _verificationMethod: string): Promise<boolean> {
    // Recompute and compare in constant time (HMAC verification).
    const expected = await this.sign(payload);
    return timingSafeEqual(expected, proofValue);
  }
}

// ── Canonical payload + sign/verify helpers ──

/** Canonical bytes a mandate proof is computed over: the credential minus `proof`. */
export function canonicalMandatePayload(credential: MandateCredential): string {
  const { proof: _proof, ...rest } = credential;
  return canonicalJSON(rest);
}

/** Attach a signed proof to an unsigned mandate. */
export async function signMandate(
  credential: MandateCredential,
  signer: MandateSigner,
): Promise<MandateCredential> {
  const proofValue = await signer.sign(canonicalMandatePayload(credential));
  return {
    ...credential,
    proof: {
      type: signer.proofType,
      created: new Date().toISOString(),
      verificationMethod: signer.verificationMethod,
      proofPurpose: 'assertionMethod',
      proofValue,
    },
  };
}

/**
 * Cryptographically verify a mandate's proof. This is the check missing from
 * {@link verifyMandateCredential}, which only validates proof *structure*.
 */
export async function verifyMandateSignature(
  credential: MandateCredential,
  verifier: MandateVerifier,
): Promise<boolean> {
  const proof = credential.proof;
  if (!proof?.proofValue || !proof.verificationMethod) return false;
  return verifier.verify(
    canonicalMandatePayload(credential),
    proof.proofValue,
    proof.verificationMethod,
  );
}

// ── Scope attenuation ──

/** Thrown when a delegation would broaden authority or exceed depth. */
export class DelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationError';
  }
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * Narrow a parent spending limit by an optional request. The result is always
 * ≤ the parent on every dimension (monotonic attenuation).
 */
function attenuateSpending(
  parent: MandateSpendingLimit,
  requested?: Partial<MandateSpendingLimit>,
): MandateSpendingLimit {
  const cap = (req: number | undefined, max: number) =>
    req === undefined ? max : Math.min(req, max);
  return {
    maxAmountUSD: cap(requested?.maxAmountUSD, parent.maxAmountUSD),
    currency: parent.currency,
    perTransaction: minDefined(requested?.perTransaction, parent.perTransaction),
    perDay: minDefined(requested?.perDay, parent.perDay),
  };
}

export interface AttenuateMandateParams {
  parent: MandateCredential;
  delegateAgentId: string;
  purpose: string;
  childMandateId: string;
  issuer: string;
  requestedScope?: {
    spendingLimits?: Partial<MandateSpendingLimit>;
    actionConstraints?: MandateActionConstraint;
    declaredIntent?: string;
  };
  /** Child lifetime; the child never outlives the parent regardless. */
  ttlMs?: number;
  now?: number;
  defaultMaxDepth?: number;
}

/**
 * Derive an **unsigned** child mandate from a parent, with monotonically
 * narrowed scope and an incremented delegation depth. Throws
 * {@link DelegationError} on an escalation attempt or depth overflow.
 */
export function attenuateMandate(params: AttenuateMandateParams): MandateCredential {
  const { parent, delegateAgentId, purpose, childMandateId, issuer, requestedScope } = params;
  const now = params.now ?? Date.now();
  const subject = parent.credentialSubject;

  const parentDepth = subject.delegation?.depth ?? 0;
  const maxDepth = subject.delegation?.maxDepth ?? params.defaultMaxDepth ?? 3;
  const childDepth = parentDepth + 1;
  if (childDepth > maxDepth) {
    throw new DelegationError(
      `Delegation depth ${childDepth} exceeds maximum ${maxDepth} — re-delegation refused`,
    );
  }

  const childSubject: MandateCredentialSubject = {
    agentId: delegateAgentId,
    // The ultimate human/system principal is preserved down the whole chain.
    principalId: subject.principalId,
    spendingLimits: attenuateSpending(subject.spendingLimits, requestedScope?.spendingLimits),
    actionConstraints: {
      allowedTools: subject.actionConstraints.allowedTools
        ? requestedScope?.actionConstraints?.allowedTools
          ? requestedScope.actionConstraints.allowedTools.filter((t) =>
              subject.actionConstraints.allowedTools!.includes(t),
            )
          : [...subject.actionConstraints.allowedTools]
        : requestedScope?.actionConstraints?.allowedTools,
      blockedTools: [
        ...new Set([
          ...(subject.actionConstraints.blockedTools ?? []),
          ...(requestedScope?.actionConstraints?.blockedTools ?? []),
        ]),
      ],
      allowedChains: subject.actionConstraints.allowedChains
        ? requestedScope?.actionConstraints?.allowedChains
          ? requestedScope.actionConstraints.allowedChains.filter((c) =>
              subject.actionConstraints.allowedChains!.includes(c),
            )
          : [...subject.actionConstraints.allowedChains]
        : requestedScope?.actionConstraints?.allowedChains,
      allowedEndpoints: subject.actionConstraints.allowedEndpoints
        ? requestedScope?.actionConstraints?.allowedEndpoints
          ? requestedScope.actionConstraints.allowedEndpoints.filter((e) =>
              subject.actionConstraints.allowedEndpoints!.includes(e),
            )
          : [...subject.actionConstraints.allowedEndpoints]
        : requestedScope?.actionConstraints?.allowedEndpoints,
      requireIntentVerification:
        subject.actionConstraints.requireIntentVerification ||
        requestedScope?.actionConstraints?.requireIntentVerification ||
        false,
    },
    delegation: {
      delegatorAgentId: subject.agentId,
      delegateAgentId,
      depth: childDepth,
      maxDepth,
      purpose,
    },
    declaredIntent: requestedScope?.declaredIntent ?? subject.declaredIntent,
  };

  // Reject any requested tool/chain/endpoint escalation explicitly.
  assertNoEscalation(subject.actionConstraints, requestedScope?.actionConstraints);

  // The child can never outlive the parent.
  const parentExpiry = parent.expirationDate
    ? new Date(parent.expirationDate).getTime()
    : undefined;
  const requestedExpiry = params.ttlMs ? now + params.ttlMs : undefined;
  const childExpiryMs = minDefined(requestedExpiry, parentExpiry);

  return buildMandateCredential({
    id: childMandateId,
    issuer,
    subject: childSubject,
    issuanceDate: new Date(now).toISOString(),
    expirationDate: childExpiryMs ? new Date(childExpiryMs).toISOString() : undefined,
  });
}

function assertNoEscalation(
  parent: MandateActionConstraint,
  requested?: MandateActionConstraint,
): void {
  const check = (
    parentList: string[] | undefined,
    requestedList: string[] | undefined,
    label: string,
  ) => {
    if (!parentList || !requestedList) return;
    const escalations = requestedList.filter((x) => !parentList.includes(x));
    if (escalations.length > 0) {
      throw new DelegationError(
        `Delegation requests ${label} outside the parent mandate: ${escalations.join(', ')}`,
      );
    }
  };
  check(parent.allowedTools, requested?.allowedTools, 'tools');
  check(parent.allowedChains, requested?.allowedChains, 'chains');
  check(parent.allowedEndpoints, requested?.allowedEndpoints, 'endpoints');
}

// ── Delegation guard ──

export interface DelegationGuardOptions {
  verifier: MandateVerifier;
  signer: MandateSigner;
  registry?: RevocationRegistry;
  /** Depth ceiling applied when a mandate does not specify its own. */
  defaultMaxDepth?: number;
  now?: () => number;
}

export interface DelegationRequest {
  parentMandate: MandateCredential;
  delegateAgentId: string;
  purpose: string;
  childMandateId: string;
  issuer: string;
  requestedScope?: AttenuateMandateParams['requestedScope'];
  /** The concrete action being delegated, validated against the parent mandate. */
  action?: {
    toolName?: string;
    proposedAmountUSD?: number;
    currentSpendUSD?: number;
    chain?: string;
    endpoint?: string;
  };
  ttlMs?: number;
}

export interface DelegationDecision {
  allowed: boolean;
  reasons: string[];
  childMandate?: MandateCredential;
}

/**
 * Authorizes (or denies) a single delegation. Fail-closed: any verification,
 * validation, depth, or attenuation failure yields `allowed: false` with no
 * child mandate.
 */
export class DelegationGuard {
  private readonly verifier: MandateVerifier;
  private readonly signer: MandateSigner;
  private readonly registry?: RevocationRegistry;
  private readonly defaultMaxDepth: number;
  private readonly now: () => number;

  constructor(options: DelegationGuardOptions) {
    this.verifier = options.verifier;
    this.signer = options.signer;
    this.registry = options.registry;
    this.defaultMaxDepth = options.defaultMaxDepth ?? 3;
    this.now = options.now ?? Date.now;
  }

  async authorizeDelegation(request: DelegationRequest): Promise<DelegationDecision> {
    const reasons: string[] = [];
    const { parentMandate, action } = request;

    // 1. Cryptographically verify the parent mandate.
    const signatureValid = await verifyMandateSignature(parentMandate, this.verifier);
    if (!signatureValid) {
      reasons.push('Parent mandate signature is invalid or missing — refusing delegation');
      return { allowed: false, reasons };
    }

    // 2. Validate the parent mandate for the action being delegated.
    const verification = verifyMandateCredential(parentMandate, {
      registry: this.registry,
      currentSpendUSD: action?.currentSpendUSD,
      proposedAmountUSD: action?.proposedAmountUSD,
      toolName: action?.toolName,
      chain: action?.chain,
      endpoint: action?.endpoint,
    });
    if (!verification.valid) {
      reasons.push(...verification.reasons);
      return { allowed: false, reasons };
    }

    // 3 + 4. Depth + monotonic attenuation produce the child mandate.
    let unsignedChild: MandateCredential;
    try {
      unsignedChild = attenuateMandate({
        parent: parentMandate,
        delegateAgentId: request.delegateAgentId,
        purpose: request.purpose,
        childMandateId: request.childMandateId,
        issuer: request.issuer,
        requestedScope: request.requestedScope,
        ttlMs: request.ttlMs,
        now: this.now(),
        defaultMaxDepth: this.defaultMaxDepth,
      });
    } catch (err) {
      reasons.push(err instanceof Error ? err.message : String(err));
      return { allowed: false, reasons };
    }

    // 5. Sign the child mandate.
    const childMandate = await signMandate(unsignedChild, this.signer);
    return { allowed: true, reasons, childMandate };
  }
}
