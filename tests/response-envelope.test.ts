/**
 * Tests for response envelope building and verification.
 */

import { describe, it, expect } from 'vitest';
import {
  buildResponseEnvelope,
  verifyResponseEnvelope,
  sha256,
} from '../src/models/integrity';
import type { AgentIdentityClaims, AgentIntegrityBinding } from '../src/types/identity';

// ── Helpers ──

const mockIdentity: AgentIdentityClaims = {
  issuer: 'veridex.io',
  subject: 'test-agent',
  name: 'Test Agent',
  version: '1.0.0',
  issuedAt: Date.now(),
  scopes: ['read', 'pay'],
};

const mockIntegrity: AgentIntegrityBinding = {
  definitionHash: 'a'.repeat(64),
  toolManifestHash: 'b'.repeat(64),
  agentChecksum: 'c'.repeat(64),
  computedAt: Date.now(),
};

// ── buildResponseEnvelope ──

describe('buildResponseEnvelope', () => {
  it('produces a complete envelope', async () => {
    const envelope = await buildResponseEnvelope({
      runId: 'run_1',
      identity: mockIdentity,
      integrity: mockIntegrity,
      output: 'Hello, world!',
      model: 'gpt-4o',
      provider: 'openai',
    });

    expect(envelope.version).toBe(1);
    expect(envelope.id).toMatch(/^env_/);
    expect(envelope.runId).toBe('run_1');
    expect(envelope.identity).toEqual(mockIdentity);
    expect(envelope.integrity).toEqual(mockIntegrity);
    expect(envelope.output).toBe('Hello, world!');
    expect(envelope.model).toBe('gpt-4o');
    expect(envelope.provider).toBe('openai');
    expect(envelope.outputHash).toHaveLength(64);
    expect(envelope.envelopeHash).toHaveLength(64);
    expect(envelope.assembledAt).toBeGreaterThan(0);
  });

  it('includes policy snapshot when provided', async () => {
    const envelope = await buildResponseEnvelope({
      runId: 'run_1',
      identity: mockIdentity,
      integrity: mockIntegrity,
      output: 'Result',
      model: 'gpt-4o',
      provider: 'openai',
      policySnapshot: [
        { ruleId: 'rule-1', verdict: 'pass', riskScore: 10, evaluatedAt: Date.now() },
      ],
    });

    expect(envelope.policySnapshot).toHaveLength(1);
    expect(envelope.policySnapshot![0].ruleId).toBe('rule-1');
  });

  it('output hash matches sha256 of output', async () => {
    const output = 'Test output content';
    const envelope = await buildResponseEnvelope({
      runId: 'run_1',
      identity: mockIdentity,
      integrity: mockIntegrity,
      output,
      model: 'gpt-4o',
      provider: 'openai',
    });

    const expectedHash = await sha256(output);
    expect(envelope.outputHash).toBe(expectedHash);
  });
});

// ── verifyResponseEnvelope ──

describe('verifyResponseEnvelope', () => {
  it('passes for a freshly built envelope', async () => {
    const envelope = await buildResponseEnvelope({
      runId: 'run_1',
      identity: mockIdentity,
      integrity: mockIntegrity,
      output: 'Valid output',
      model: 'gpt-4o',
      provider: 'openai',
    });

    const result = await verifyResponseEnvelope(envelope);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects tampered output', async () => {
    const envelope = await buildResponseEnvelope({
      runId: 'run_1',
      identity: mockIdentity,
      integrity: mockIntegrity,
      output: 'Original output',
      model: 'gpt-4o',
      provider: 'openai',
    });

    // Tamper with output
    const tampered = { ...envelope, output: 'Tampered output' };
    const result = await verifyResponseEnvelope(tampered);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Output hash mismatch — content may have been tampered with');
  });

  it('detects tampered envelope metadata', async () => {
    const envelope = await buildResponseEnvelope({
      runId: 'run_1',
      identity: mockIdentity,
      integrity: mockIntegrity,
      output: 'Original output',
      model: 'gpt-4o',
      provider: 'openai',
    });

    // Tamper with runId (changes envelope hash but not output hash)
    const tampered = { ...envelope, runId: 'run_hacked' };
    const result = await verifyResponseEnvelope(tampered);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Envelope hash mismatch'))).toBe(true);
  });

  it('detects expired identity', async () => {
    const expiredIdentity: AgentIdentityClaims = {
      ...mockIdentity,
      expiresAt: Date.now() - 60_000, // expired 1 minute ago
    };
    const envelope = await buildResponseEnvelope({
      runId: 'run_1',
      identity: expiredIdentity,
      integrity: mockIntegrity,
      output: 'Output',
      model: 'gpt-4o',
      provider: 'openai',
    });

    const result = await verifyResponseEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Agent identity has expired');
  });

  it('passes for non-expired identity', async () => {
    const validIdentity: AgentIdentityClaims = {
      ...mockIdentity,
      expiresAt: Date.now() + 3_600_000, // expires in 1 hour
    };
    const envelope = await buildResponseEnvelope({
      runId: 'run_1',
      identity: validIdentity,
      integrity: mockIntegrity,
      output: 'Output',
      model: 'gpt-4o',
      provider: 'openai',
    });

    const result = await verifyResponseEnvelope(envelope);
    expect(result.valid).toBe(true);
  });
});
