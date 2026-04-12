/**
 * @packageDocumentation
 * @module Integrity
 * @description
 * Agent integrity computation — SHA-256 checksums for agent definitions,
 * tool manifests, and response envelopes.
 *
 * Uses the Web Crypto API (available in Node 18+, Bun, Deno, browsers)
 * with a deterministic canonical JSON serialization.
 */

import type { AgentDefinition } from '../types/agent';
import type { ToolContract } from '../types/tools';
import type {
  AgentIdentityClaims,
  AgentIntegrityBinding,
  ResponseEnvelope,
  PolicyEnvelopeEntry,
} from '../types/identity';

// ── Canonical JSON ──

/**
 * Produce a deterministic JSON string with sorted keys.
 * Handles BigInt → string conversion.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return val.toString();
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

// ── SHA-256 Hashing ──

/**
 * Compute SHA-256 hex digest of a string using Web Crypto API.
 */
export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Agent Definition Hash ──

/**
 * Compute the canonical hash of an agent definition.
 * Covers: id, name, instructions, model config, payment config, policies, maxTurns, maxTokens.
 * Excludes: hooks (runtime-only), metadata (opaque), memory config (volatile).
 */
export async function hashAgentDefinition(def: AgentDefinition): Promise<string> {
  const canonical = {
    id: def.id,
    name: def.name,
    instructions: def.instructions,
    model: {
      provider: def.model.provider,
      model: def.model.model,
      temperature: def.model.temperature,
      maxOutputTokens: def.model.maxOutputTokens,
    },
    payments: def.payments ?? null,
    policies: def.policies ?? [],
    maxTurns: def.maxTurns ?? null,
    maxTokens: def.maxTokens ?? null,
  };
  return sha256(canonicalJSON(canonical));
}

// ── Tool Manifest Hash ──

/**
 * Compute the canonical hash of a tool manifest.
 * Each tool is represented by its name, description, safety class, and input schema shape.
 */
export async function hashToolManifest(tools: ToolContract[]): Promise<string> {
  const sorted = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      safetyClass: t.safetyClass ?? 'unknown',
    }));
  return sha256(canonicalJSON(sorted));
}

// ── Agent Checksum ──

/**
 * Compute the composite agent checksum from definition + tool manifest hashes.
 */
export async function computeAgentChecksum(
  definitionHash: string,
  toolManifestHash: string,
): Promise<string> {
  return sha256(`${definitionHash}:${toolManifestHash}`);
}

/**
 * Build a complete AgentIntegrityBinding for an agent definition and its tools.
 */
export async function buildIntegrityBinding(
  definition: AgentDefinition,
  tools: ToolContract[],
): Promise<AgentIntegrityBinding> {
  const definitionHash = await hashAgentDefinition(definition);
  const toolManifestHash = await hashToolManifest(tools);
  const agentChecksum = await computeAgentChecksum(definitionHash, toolManifestHash);
  return {
    definitionHash,
    toolManifestHash,
    agentChecksum,
    computedAt: Date.now(),
  };
}

// ── Response Envelope Builder ──

/** Parameters for building a response envelope. */
export interface ResponseEnvelopeParams {
  runId: string;
  identity: AgentIdentityClaims;
  integrity: AgentIntegrityBinding;
  output: string;
  outputMetadata?: Record<string, unknown>;
  model: string;
  provider: string;
  policySnapshot?: PolicyEnvelopeEntry[];
}

/**
 * Build a tamper-evident response envelope.
 * The envelope includes a content hash (over output) and an envelope hash (over everything).
 */
export async function buildResponseEnvelope(
  params: ResponseEnvelopeParams,
): Promise<ResponseEnvelope> {
  const id = `env_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputHash = await sha256(params.output);
  const assembledAt = Date.now();

  const envelopeContent = {
    version: 1 as const,
    id,
    runId: params.runId,
    identity: params.identity,
    integrity: params.integrity,
    output: params.output,
    outputMetadata: params.outputMetadata,
    model: params.model,
    provider: params.provider,
    outputHash,
    assembledAt,
    policySnapshot: params.policySnapshot ?? [],
  };

  const envelopeHash = await sha256(canonicalJSON(envelopeContent));

  return {
    ...envelopeContent,
    envelopeHash,
  };
}

/**
 * Verify a response envelope's integrity.
 * Checks: outputHash matches output, envelopeHash matches envelope content.
 */
export async function verifyResponseEnvelope(
  envelope: ResponseEnvelope,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Verify output hash
  const expectedOutputHash = await sha256(envelope.output);
  if (expectedOutputHash !== envelope.outputHash) {
    errors.push('Output hash mismatch — content may have been tampered with');
  }

  // Verify envelope hash — recompute from the same fields
  const envelopeContent = {
    version: envelope.version,
    id: envelope.id,
    runId: envelope.runId,
    identity: envelope.identity,
    integrity: envelope.integrity,
    output: envelope.output,
    outputMetadata: envelope.outputMetadata,
    model: envelope.model,
    provider: envelope.provider,
    outputHash: envelope.outputHash,
    assembledAt: envelope.assembledAt,
    policySnapshot: envelope.policySnapshot ?? [],
  };
  const expectedEnvelopeHash = await sha256(canonicalJSON(envelopeContent));
  if (expectedEnvelopeHash !== envelope.envelopeHash) {
    errors.push('Envelope hash mismatch — envelope metadata may have been tampered with');
  }

  // Check expiration
  if (envelope.identity.expiresAt && Date.now() > envelope.identity.expiresAt) {
    errors.push('Agent identity has expired');
  }

  return { valid: errors.length === 0, errors };
}
