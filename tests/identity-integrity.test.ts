/**
 * Tests for agent identity types and integrity computation.
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalJSON,
  sha256,
  hashAgentDefinition,
  hashToolManifest,
  computeAgentChecksum,
  buildIntegrityBinding,
} from '../src/models/integrity';
import type { AgentDefinition } from '../src/types/agent';
import type { ToolContract } from '../src/types/tools';
import type { AgentIdentityClaims } from '../src/types/identity';

// ── Helpers ──

const mockDefinition: AgentDefinition = {
  id: 'test-agent',
  name: 'Test Agent',
  model: { provider: 'openai', model: 'gpt-4o', temperature: 0.7 },
  instructions: 'You are a test agent.',
  tools: [],
  maxTurns: 10,
};

const mockTool: ToolContract = {
  name: 'greet',
  description: 'Greet a user',
  safetyClass: 'read',
  input: {} as any,
  execute: async () => ({ llmOutput: 'Hello!', success: true }),
};

// ── canonicalJSON ──

describe('canonicalJSON', () => {
  it('sorts object keys deterministically', () => {
    const a = canonicalJSON({ z: 1, a: 2, m: 3 });
    const b = canonicalJSON({ a: 2, z: 1, m: 3 });
    expect(a).toBe(b);
    const parsed = JSON.parse(a);
    const keys = Object.keys(parsed);
    expect(keys).toEqual(['a', 'm', 'z']);
  });

  it('converts BigInt to string', () => {
    const result = canonicalJSON({ value: BigInt(42) });
    expect(result).toContain('"42"');
  });

  it('handles nested objects with sorted keys', () => {
    const result = canonicalJSON({ b: { z: 1, a: 2 }, a: 3 });
    const parsed = JSON.parse(result);
    expect(Object.keys(parsed)).toEqual(['a', 'b']);
  });
});

// ── sha256 ──

describe('sha256', () => {
  it('produces a 64-character hex string', async () => {
    const hash = await sha256('hello world');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', async () => {
    const a = await sha256('test input');
    const b = await sha256('test input');
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', async () => {
    const a = await sha256('input A');
    const b = await sha256('input B');
    expect(a).not.toBe(b);
  });
});

// ── hashAgentDefinition ──

describe('hashAgentDefinition', () => {
  it('produces a stable hash for the same definition', async () => {
    const a = await hashAgentDefinition(mockDefinition);
    const b = await hashAgentDefinition(mockDefinition);
    expect(a).toBe(b);
  });

  it('produces different hashes when instructions change', async () => {
    const modified = { ...mockDefinition, instructions: 'Different instructions' };
    const a = await hashAgentDefinition(mockDefinition);
    const b = await hashAgentDefinition(modified);
    expect(a).not.toBe(b);
  });

  it('produces different hashes when model changes', async () => {
    const modified = {
      ...mockDefinition,
      model: { ...mockDefinition.model, model: 'claude-sonnet-4' },
    };
    const a = await hashAgentDefinition(mockDefinition);
    const b = await hashAgentDefinition(modified);
    expect(a).not.toBe(b);
  });

  it('ignores hooks and metadata changes', async () => {
    const withHooks = {
      ...mockDefinition,
      hooks: { afterTurn: [] },
      metadata: { version: '2.0' },
    };
    const a = await hashAgentDefinition(mockDefinition);
    const b = await hashAgentDefinition(withHooks);
    expect(a).toBe(b);
  });
});

// ── hashToolManifest ──

describe('hashToolManifest', () => {
  it('produces a stable hash for the same tools', async () => {
    const tools = [mockTool];
    const a = await hashToolManifest(tools);
    const b = await hashToolManifest(tools);
    expect(a).toBe(b);
  });

  it('is order-independent (sorted by name)', async () => {
    const tool2: ToolContract = {
      name: 'farewell',
      description: 'Say goodbye',
      safetyClass: 'read',
      input: {} as any,
      execute: async () => ({ llmOutput: 'Bye!', success: true }),
    };
    const a = await hashToolManifest([mockTool, tool2]);
    const b = await hashToolManifest([tool2, mockTool]);
    expect(a).toBe(b);
  });

  it('empty tool list has a stable hash', async () => {
    const a = await hashToolManifest([]);
    const b = await hashToolManifest([]);
    expect(a).toBe(b);
  });
});

// ── computeAgentChecksum ──

describe('computeAgentChecksum', () => {
  it('combines definition and tool hashes', async () => {
    const defHash = await hashAgentDefinition(mockDefinition);
    const toolHash = await hashToolManifest([mockTool]);
    const checksum = await computeAgentChecksum(defHash, toolHash);
    expect(checksum).toHaveLength(64);
  });

  it('changes when either hash changes', async () => {
    const a = await computeAgentChecksum('abc', 'def');
    const b = await computeAgentChecksum('abc', 'ghi');
    const c = await computeAgentChecksum('xyz', 'def');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

// ── buildIntegrityBinding ──

describe('buildIntegrityBinding', () => {
  it('builds a complete binding', async () => {
    const binding = await buildIntegrityBinding(mockDefinition, [mockTool]);
    expect(binding.definitionHash).toHaveLength(64);
    expect(binding.toolManifestHash).toHaveLength(64);
    expect(binding.agentChecksum).toHaveLength(64);
    expect(binding.computedAt).toBeGreaterThan(0);
  });

  it('checksum matches manual computation', async () => {
    const binding = await buildIntegrityBinding(mockDefinition, [mockTool]);
    const manualChecksum = await computeAgentChecksum(
      binding.definitionHash,
      binding.toolManifestHash,
    );
    expect(binding.agentChecksum).toBe(manualChecksum);
  });
});

// ── AgentIdentityClaims ──

describe('AgentIdentityClaims', () => {
  it('can express a complete identity', () => {
    const claims: AgentIdentityClaims = {
      issuer: 'veridex.io',
      subject: 'test-agent',
      name: 'Test Agent',
      version: '1.0.0',
      issuedAt: Date.now(),
      audience: ['api.example.com'],
      scopes: ['read', 'write', 'pay'],
      maxDelegationDepth: 2,
    };
    expect(claims.issuer).toBe('veridex.io');
    expect(claims.scopes).toHaveLength(3);
    expect(claims.maxDelegationDepth).toBe(2);
  });

  it('supports minimal claims', () => {
    const claims: AgentIdentityClaims = {
      issuer: 'veridex.io',
      subject: 'minimal-agent',
      name: 'Minimal',
      version: '0.1.0',
      issuedAt: Date.now(),
    };
    expect(claims.scopes).toBeUndefined();
    expect(claims.expiresAt).toBeUndefined();
  });
});
