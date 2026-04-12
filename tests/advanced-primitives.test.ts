/**
 * Tests for Phase 4: TEE, ZK, SBT, and Envelope Activation
 */
import { describe, it, expect } from 'vitest';
import {
  MockTEEAttestor,
  MockZKComplianceProver,
  SBTReputationTracker,
  activateEnvelope,
  DEFAULT_ENVELOPE_ACTIVATION,
} from '../src';
import type {
  TEEAttestation,
  ZKComplianceClaim,
  EnvelopeActivationConfig,
} from '../src';

// ── MockTEEAttestor ──

describe('MockTEEAttestor', () => {
  it('generates attestation with platform mock', async () => {
    const attestor = new MockTEEAttestor();
    const att = await attestor.attest('nonce-123');
    expect(att.platform).toBe('mock');
    expect(att.nonce).toBe('nonce-123');
    expect(att.quoteHex).toBeTruthy();
    expect(Object.keys(att.measurements).length).toBeGreaterThan(0);
    expect(att.attestedAt).toBeGreaterThan(0);
  });

  it('verifies matching measurements', async () => {
    const measurements = { pcr0: 'aa'.repeat(32) };
    const attestor = new MockTEEAttestor(measurements);
    const att = await attestor.attest();
    const result = await attestor.verify(att, measurements);
    expect(result.valid).toBe(true);
    expect(result.measurementsMatch).toBe(true);
    expect(result.fresh).toBe(true);
  });

  it('rejects mismatched measurements', async () => {
    const attestor = new MockTEEAttestor({ pcr0: 'aa'.repeat(32) });
    const att = await attestor.attest();
    const result = await attestor.verify(att, { pcr0: 'bb'.repeat(32) });
    expect(result.valid).toBe(false);
    expect(result.measurementsMatch).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('rejects stale attestations', async () => {
    const attestor = new MockTEEAttestor({ pcr0: 'aa'.repeat(32) });
    const att = await attestor.attest();
    // Backdate by 10 minutes
    att.attestedAt = Date.now() - 10 * 60 * 1000;
    const result = await attestor.verify(att, { pcr0: 'aa'.repeat(32) });
    expect(result.fresh).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('uses custom measurements', async () => {
    const custom = { mr_enclave: 'dead'.repeat(16) };
    const attestor = new MockTEEAttestor(custom);
    const att = await attestor.attest();
    expect(att.measurements.mr_enclave).toBe('dead'.repeat(16));
  });
});

// ── MockZKComplianceProver ──

describe('MockZKComplianceProver', () => {
  const claim: ZKComplianceClaim = {
    type: 'spending_within_limit',
    description: 'Agent spending under $500',
    publicParams: { maxUSD: 500, currentUSD: 200 },
  };

  it('generates proof with correct circuit id', async () => {
    const prover = new MockZKComplianceProver();
    const proof = await prover.prove(claim, { secret: 'witness' });
    expect(proof.system).toBe('mock');
    expect(proof.circuitId).toBe('mock-spending_within_limit');
    expect(proof.proofHex.length).toBeGreaterThan(0);
    expect(proof.publicInputs).toEqual(['500', '200']);
    expect(proof.claim).toEqual(claim);
  });

  it('verifies valid proof', async () => {
    const prover = new MockZKComplianceProver();
    const proof = await prover.prove(claim, {});
    const result = await prover.verify(proof);
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('rejects proof with empty inputs', async () => {
    const prover = new MockZKComplianceProver();
    const proof = await prover.prove(claim, {});
    proof.publicInputs = [];
    const result = await prover.verify(proof);
    expect(result.valid).toBe(false);
  });

  it('reports correct system', () => {
    const prover = new MockZKComplianceProver();
    expect(prover.system).toBe('mock');
  });
});

// ── SBTReputationTracker ──

describe('SBTReputationTracker', () => {
  it('creates neutral reputation', () => {
    const tracker = new SBTReputationTracker();
    const rep = tracker.getOrCreate('agent-1');
    expect(rep.agentId).toBe('agent-1');
    expect(rep.aggregateScore).toBe(50);
    expect(rep.scores).toEqual([]);
    expect(rep.totalInteractions).toBe(0);
  });

  it('applies positive update', () => {
    const tracker = new SBTReputationTracker();
    tracker.getOrCreate('a1');
    const rep = tracker.applyUpdate({
      agentId: 'a1',
      dimension: 'reliability',
      delta: 20,
      source: 'test',
      timestamp: Date.now(),
    });
    expect(rep.totalInteractions).toBe(1);
    const reliability = rep.scores.find((s) => s.dimension === 'reliability');
    expect(reliability).toBeDefined();
    expect(reliability!.score).toBeGreaterThan(50);
    expect(reliability!.evaluationCount).toBe(1);
  });

  it('applies negative update (clamped to 0)', () => {
    const tracker = new SBTReputationTracker();
    tracker.getOrCreate('a1');
    const rep = tracker.applyUpdate({
      agentId: 'a1',
      dimension: 'safety',
      delta: -200, // Over-clamp test
      source: 'test',
      timestamp: Date.now(),
    });
    const safety = rep.scores.find((s) => s.dimension === 'safety');
    expect(safety!.score).toBeGreaterThanOrEqual(0);
  });

  it('recomputes aggregate across dimensions', () => {
    const tracker = new SBTReputationTracker();
    tracker.applyUpdate({ agentId: 'a1', dimension: 'reliability', delta: 20, source: 'test', timestamp: Date.now() });
    tracker.applyUpdate({ agentId: 'a1', dimension: 'accuracy', delta: 10, source: 'test', timestamp: Date.now() });
    const rep = tracker.get('a1')!;
    expect(rep.scores).toHaveLength(2);
    const expected = rep.scores.reduce((s, sc) => s + sc.score, 0) / rep.scores.length;
    expect(rep.aggregateScore).toBeCloseTo(expected, 5);
  });

  it('threshold check works', () => {
    const tracker = new SBTReputationTracker();
    tracker.applyUpdate({ agentId: 'a1', dimension: 'reliability', delta: 30, source: 'test', timestamp: Date.now() });
    expect(tracker.meetsThreshold('a1', 50)).toBe(true);
    expect(tracker.meetsThreshold('a1', 100)).toBe(false);
    expect(tracker.meetsThreshold('nonexistent', 0)).toBe(false);
  });

  it('lists tracked agents', () => {
    const tracker = new SBTReputationTracker();
    tracker.getOrCreate('x');
    tracker.getOrCreate('y');
    expect(tracker.listAgents()).toEqual(['x', 'y']);
  });

  it('idempotent getOrCreate', () => {
    const tracker = new SBTReputationTracker();
    const first = tracker.getOrCreate('a');
    tracker.applyUpdate({ agentId: 'a', dimension: 'safety', delta: 5, source: 'x', timestamp: Date.now() });
    const second = tracker.getOrCreate('a');
    expect(second.totalInteractions).toBe(1);
    expect(first).toBe(second); // Same reference
  });
});

// ── activateEnvelope ──

describe('activateEnvelope', () => {
  it('activates with default config (no TEE, no ZK)', async () => {
    const result = await activateEnvelope(DEFAULT_ENVELOPE_ACTIVATION, 'env-1');
    expect(result.activated).toBe(true);
    expect(result.teeAttestation).toBeUndefined();
    expect(result.complianceProof).toBeUndefined();
  });

  it('activates with TEE attestor', async () => {
    const config: EnvelopeActivationConfig = {
      ...DEFAULT_ENVELOPE_ACTIVATION,
      teeAttestor: new MockTEEAttestor(),
    };
    const result = await activateEnvelope(config, 'env-2');
    expect(result.activated).toBe(true);
    expect(result.teeAttestation).toBeDefined();
    expect(result.teeAttestation!.nonce).toBe('env-2');
  });

  it('activates with ZK prover', async () => {
    const claim: ZKComplianceClaim = {
      type: 'action_authorized',
      description: 'Agent action authorized',
      publicParams: { action: 'transfer' },
    };
    const config: EnvelopeActivationConfig = {
      ...DEFAULT_ENVELOPE_ACTIVATION,
      zkProver: new MockZKComplianceProver(),
    };
    const result = await activateEnvelope(config, 'env-3', claim);
    expect(result.activated).toBe(true);
    expect(result.complianceProof).toBeDefined();
    expect(result.complianceProof!.claim.type).toBe('action_authorized');
  });

  it('activates with both TEE and ZK', async () => {
    const claim: ZKComplianceClaim = {
      type: 'spending_within_limit',
      description: 'Under limit',
      publicParams: { limit: 1000 },
    };
    const config: EnvelopeActivationConfig = {
      ...DEFAULT_ENVELOPE_ACTIVATION,
      teeAttestor: new MockTEEAttestor(),
      zkProver: new MockZKComplianceProver(),
    };
    const result = await activateEnvelope(config, 'env-4', claim);
    expect(result.activated).toBe(true);
    expect(result.teeAttestation).toBeDefined();
    expect(result.complianceProof).toBeDefined();
  });

  it('skips ZK proof when no claim provided', async () => {
    const config: EnvelopeActivationConfig = {
      ...DEFAULT_ENVELOPE_ACTIVATION,
      zkProver: new MockZKComplianceProver(),
    };
    const result = await activateEnvelope(config, 'env-5');
    expect(result.activated).toBe(true);
    expect(result.complianceProof).toBeUndefined();
  });
});
