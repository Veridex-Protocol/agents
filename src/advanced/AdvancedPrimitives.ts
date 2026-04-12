/**
 * @module advanced
 * @description
 * Phase 4 advanced primitives:
 *
 * - TEE Attestation: Interface + mock for Trusted Execution Environment attestations
 * - ZK Compliance: Types + interface for zero-knowledge compliance proofs
 * - SBT Reputation: Soulbound Token reputation types for agent trust scoring
 * - Provider Envelope Activation: Helper to activate provider response envelopes
 *
 * @see ADR-0045 — Phase 4: ZK + TEE + Advanced
 */

// ══════════════════════════════════════════════════════════════
// TEE Attestation
// ══════════════════════════════════════════════════════════════

/** TEE platform type. */
export type TEEPlatform = 'sgx' | 'sev-snp' | 'trustzone' | 'nitro' | 'mock';

/** TEE attestation evidence. */
export interface TEEAttestation {
  /** Platform that produced the attestation */
  platform: TEEPlatform;
  /** Attestation quote/report (hex-encoded) */
  quoteHex: string;
  /** PCR / measurement register values */
  measurements: Record<string, string>;
  /** Timestamp of attestation */
  attestedAt: number;
  /** Optional nonce used for freshness */
  nonce?: string;
  /** Signer identity (if available) */
  signerIdentity?: string;
}

/** Result of TEE attestation verification. */
export interface TEEVerificationResult {
  valid: boolean;
  platform: TEEPlatform;
  reasons: string[];
  measurementsMatch: boolean;
  /** Whether the attestation is fresh (within acceptable window) */
  fresh: boolean;
  verifiedAt: number;
}

/** TEE attestor interface. Pluggable to any TEE backend. */
export interface TEEAttestor {
  /** Get the platform type. */
  readonly platform: TEEPlatform;
  /** Generate a fresh attestation. */
  attest(nonce?: string): Promise<TEEAttestation>;
  /** Verify an attestation against expected measurements. */
  verify(
    attestation: TEEAttestation,
    expectedMeasurements: Record<string, string>,
  ): Promise<TEEVerificationResult>;
}

/**
 * Mock TEE attestor for testing and development.
 * Produces syntactically valid attestations without hardware.
 */
export class MockTEEAttestor implements TEEAttestor {
  readonly platform: TEEPlatform = 'mock';
  private readonly measurements: Record<string, string>;

  constructor(measurements?: Record<string, string>) {
    this.measurements = measurements ?? {
      'pcr0': 'a'.repeat(64),
      'pcr1': 'b'.repeat(64),
      'pcr2': 'c'.repeat(64),
    };
  }

  async attest(nonce?: string): Promise<TEEAttestation> {
    return {
      platform: 'mock',
      quoteHex: '0'.repeat(128),
      measurements: { ...this.measurements },
      attestedAt: Date.now(),
      nonce,
      signerIdentity: 'mock-signer',
    };
  }

  async verify(
    attestation: TEEAttestation,
    expectedMeasurements: Record<string, string>,
  ): Promise<TEEVerificationResult> {
    const reasons: string[] = [];
    let measurementsMatch = true;

    for (const [key, expected] of Object.entries(expectedMeasurements)) {
      if (attestation.measurements[key] !== expected) {
        measurementsMatch = false;
        reasons.push(`Measurement '${key}' mismatch: expected ${expected}, got ${attestation.measurements[key] ?? 'undefined'}`);
      }
    }

    // Check freshness (5 minute window)
    const fresh = Date.now() - attestation.attestedAt < 5 * 60 * 1000;
    if (!fresh) {
      reasons.push('Attestation is stale (>5 minutes old)');
    }

    return {
      valid: measurementsMatch && fresh && reasons.length === 0,
      platform: attestation.platform,
      reasons,
      measurementsMatch,
      fresh,
      verifiedAt: Date.now(),
    };
  }
}

// ══════════════════════════════════════════════════════════════
// ZK Compliance
// ══════════════════════════════════════════════════════════════

/** ZK proof system type. */
export type ZKProofSystem = 'groth16' | 'plonk' | 'spartan' | 'nova' | 'mock';

/** A zero-knowledge compliance proof. */
export interface ZKComplianceProof {
  /** Proof system used */
  system: ZKProofSystem;
  /** Circuit identifier */
  circuitId: string;
  /** Proof data (hex-encoded) */
  proofHex: string;
  /** Public inputs (hex-encoded values) */
  publicInputs: string[];
  /** What this proof attests to */
  claim: ZKComplianceClaim;
  /** Generation timestamp */
  generatedAt: number;
}

/** Types of compliance claims provable in zero-knowledge. */
export type ZKComplianceClaimType =
  | 'spending_within_limit'
  | 'action_authorized'
  | 'identity_valid'
  | 'delegation_depth_ok'
  | 'jurisdiction_compliant'
  | 'age_verified'
  | 'accredited_investor';

/** A compliance claim with structured data. */
export interface ZKComplianceClaim {
  type: ZKComplianceClaimType;
  /** Claim description */
  description: string;
  /** Claim-specific parameters (public) */
  publicParams: Record<string, unknown>;
}

/** Result of ZK proof verification. */
export interface ZKVerificationResult {
  valid: boolean;
  system: ZKProofSystem;
  circuitId: string;
  claim: ZKComplianceClaim;
  reasons: string[];
  verifiedAt: number;
}

/** ZK compliance prover interface. Pluggable to any ZK backend. */
export interface ZKComplianceProver {
  /** Get the proof system type. */
  readonly system: ZKProofSystem;
  /** Generate a compliance proof. */
  prove(claim: ZKComplianceClaim, witness: Record<string, unknown>): Promise<ZKComplianceProof>;
  /** Verify a compliance proof. */
  verify(proof: ZKComplianceProof): Promise<ZKVerificationResult>;
}

/**
 * Mock ZK compliance prover for testing.
 * Accepts all proofs with valid structure.
 */
export class MockZKComplianceProver implements ZKComplianceProver {
  readonly system: ZKProofSystem = 'mock';

  async prove(claim: ZKComplianceClaim, _witness: Record<string, unknown>): Promise<ZKComplianceProof> {
    return {
      system: 'mock',
      circuitId: `mock-${claim.type}`,
      proofHex: 'f'.repeat(64),
      publicInputs: Object.values(claim.publicParams).map(String),
      claim,
      generatedAt: Date.now(),
    };
  }

  async verify(proof: ZKComplianceProof): Promise<ZKVerificationResult> {
    const valid = proof.proofHex.length > 0 && proof.publicInputs.length > 0;
    return {
      valid,
      system: proof.system,
      circuitId: proof.circuitId,
      claim: proof.claim,
      reasons: valid ? [] : ['Invalid proof structure'],
      verifiedAt: Date.now(),
    };
  }
}

// ══════════════════════════════════════════════════════════════
// SBT Reputation
// ══════════════════════════════════════════════════════════════

/** Reputation dimension. */
export type ReputationDimension =
  | 'reliability'
  | 'accuracy'
  | 'safety'
  | 'cost_efficiency'
  | 'latency'
  | 'compliance';

/** A single reputation score entry. */
export interface ReputationScore {
  dimension: ReputationDimension;
  /** Score 0-100 */
  score: number;
  /** Number of evaluations that contributed to this score */
  evaluationCount: number;
  /** Last update timestamp */
  updatedAt: number;
}

/** SBT (Soulbound Token) reputation for an agent. */
export interface SBTReputation {
  /** Agent ID this reputation belongs to */
  agentId: string;
  /** Token ID (on-chain reference, if minted) */
  tokenId?: string;
  /** Chain the SBT lives on */
  chain?: string;
  /** Individual dimension scores */
  scores: ReputationScore[];
  /** Aggregate reputation score (weighted average) */
  aggregateScore: number;
  /** Total interactions counted */
  totalInteractions: number;
  /** When this reputation was first established */
  establishedAt: number;
  /** Last mutation timestamp */
  updatedAt: number;
}

/** Reputation update event. */
export interface ReputationUpdate {
  agentId: string;
  dimension: ReputationDimension;
  /** Delta to apply (-100 to +100) */
  delta: number;
  /** Source of the update (e.g., 'user_feedback', 'automated_eval') */
  source: string;
  /** Evidence reference */
  evidenceRef?: string;
  timestamp: number;
}

/**
 * In-memory SBT reputation tracker.
 * Manages agent reputation scores across dimensions.
 */
export class SBTReputationTracker {
  private readonly reputations = new Map<string, SBTReputation>();

  /** Initialize or get reputation for an agent. */
  getOrCreate(agentId: string): SBTReputation {
    if (!this.reputations.has(agentId)) {
      const now = Date.now();
      this.reputations.set(agentId, {
        agentId,
        scores: [],
        aggregateScore: 50, // Neutral start
        totalInteractions: 0,
        establishedAt: now,
        updatedAt: now,
      });
    }
    return this.reputations.get(agentId)!;
  }

  /** Apply a reputation update. */
  applyUpdate(update: ReputationUpdate): SBTReputation {
    const rep = this.getOrCreate(update.agentId);

    let score = rep.scores.find((s) => s.dimension === update.dimension);
    if (!score) {
      score = {
        dimension: update.dimension,
        score: 50,
        evaluationCount: 0,
        updatedAt: Date.now(),
      };
      rep.scores.push(score);
    }

    // Exponential moving average
    score.evaluationCount++;
    const weight = 1 / score.evaluationCount;
    score.score = Math.max(0, Math.min(100, score.score + update.delta * weight));
    score.updatedAt = update.timestamp;

    rep.totalInteractions++;
    rep.updatedAt = update.timestamp;

    // Recompute aggregate (simple average)
    if (rep.scores.length > 0) {
      rep.aggregateScore = rep.scores.reduce((sum, s) => sum + s.score, 0) / rep.scores.length;
    }

    return rep;
  }

  /** Get reputation or null. */
  get(agentId: string): SBTReputation | null {
    return this.reputations.get(agentId) ?? null;
  }

  /** Check if an agent meets a minimum reputation threshold. */
  meetsThreshold(agentId: string, minScore: number): boolean {
    const rep = this.reputations.get(agentId);
    if (!rep) return false;
    return rep.aggregateScore >= minScore;
  }

  /** Get all tracked agents. */
  listAgents(): string[] {
    return [...this.reputations.keys()];
  }
}

// ══════════════════════════════════════════════════════════════
// Provider Envelope Activation
// ══════════════════════════════════════════════════════════════

/** Configuration for activating response envelope on a provider. */
export interface EnvelopeActivationConfig {
  /** Whether to include provider response hashes */
  includeProviderHash: boolean;
  /** Whether to enforce envelope verification on all runs */
  enforceVerification: boolean;
  /** Maximum envelope age before considered stale (ms) */
  maxEnvelopeAgeMs: number;
  /** TEE attestor to bind to envelopes (optional) */
  teeAttestor?: TEEAttestor;
  /** ZK prover for compliance claims embedded in envelopes (optional) */
  zkProver?: ZKComplianceProver;
}

/** Default envelope activation config. */
export const DEFAULT_ENVELOPE_ACTIVATION: EnvelopeActivationConfig = {
  includeProviderHash: true,
  enforceVerification: false,
  maxEnvelopeAgeMs: 5 * 60 * 1000, // 5 minutes
};

/**
 * Envelope activation result — what was bound to the envelope.
 */
export interface EnvelopeActivationResult {
  /** Whether activation succeeded */
  activated: boolean;
  /** TEE attestation (if available) */
  teeAttestation?: TEEAttestation;
  /** ZK compliance proof (if generated) */
  complianceProof?: ZKComplianceProof;
  /** Reasons for failure */
  reasons: string[];
  activatedAt: number;
}

/**
 * Activate a response envelope with TEE and/or ZK bindings.
 * This is the top-level orchestrator for Phase 4 envelope enrichment.
 */
export async function activateEnvelope(
  config: EnvelopeActivationConfig,
  envelopeId: string,
  claim?: ZKComplianceClaim,
): Promise<EnvelopeActivationResult> {
  const reasons: string[] = [];
  let teeAttestation: TEEAttestation | undefined;
  let complianceProof: ZKComplianceProof | undefined;

  // TEE attestation
  if (config.teeAttestor) {
    try {
      teeAttestation = await config.teeAttestor.attest(envelopeId);
    } catch (err) {
      reasons.push(`TEE attestation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ZK compliance proof
  if (config.zkProver && claim) {
    try {
      complianceProof = await config.zkProver.prove(claim, { envelopeId });
    } catch (err) {
      reasons.push(`ZK proof generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const activated = reasons.length === 0;
  return {
    activated,
    teeAttestation,
    complianceProof,
    reasons,
    activatedAt: Date.now(),
  };
}
