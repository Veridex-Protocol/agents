/**
 * @packageDocumentation
 * @module IdentityTypes
 * @description
 * Agent identity types for the Veridex Agent Fabric.
 *
 * Implements OIDC-A (agent identity claims) and A-JWT (agent checksum binding)
 * concepts from the secure agentic payments research. These types allow an
 * agent's identity, provenance, and integrity to be expressed declaratively
 * and verified at runtime.
 *
 * @see ADR-0045 — Secure Agentic Payment Rails
 */

// ── Agent Identity Claims (OIDC-A) ──

/**
 * OIDC-A–inspired identity claims for an agent.
 * These claims establish *who* the agent is, *who* created it,
 * and under what constraints it operates.
 */
export interface AgentIdentityClaims {
  /** Issuer — the organization or platform that deployed this agent */
  issuer: string;
  /** Subject — unique agent identifier (same as AgentDefinition.id) */
  subject: string;
  /** Audience — intended consumers of this agent's outputs */
  audience?: string[];
  /** Human-readable agent name */
  name: string;
  /** Agent version string (semver recommended) */
  version: string;
  /** Issued-at timestamp (ms since epoch) */
  issuedAt: number;
  /** Expiration timestamp (ms since epoch, optional) */
  expiresAt?: number;
  /** Scopes the agent is authorized for */
  scopes?: string[];
  /** Maximum delegation depth (0 = cannot delegate) */
  maxDelegationDepth?: number;
  /** Parent agent subject if this agent was spawned by another */
  parentAgent?: string;
  /** Additional claims (extensible) */
  claims?: Record<string, unknown>;
}

// ── Agent Checksum Binding (A-JWT) ──

/**
 * Integrity binding that ties an agent's identity to its code artifact.
 * The checksum covers the agent definition (instructions, tools, model config)
 * so any mutation is detectable.
 */
export interface AgentIntegrityBinding {
  /** SHA-256 hash of the canonical agent definition */
  definitionHash: string;
  /** SHA-256 hash of the tool registry manifest (tool names + schemas) */
  toolManifestHash: string;
  /** Composite checksum of definition + tools */
  agentChecksum: string;
  /** Timestamp when the checksum was computed */
  computedAt: number;
}

// ── Response Envelope ──

/**
 * A signed response envelope wrapping an agent's output.
 * Provides tamper-evident proof of what the agent produced,
 * under what identity, with what integrity binding.
 */
export interface ResponseEnvelope {
  /** Envelope version */
  version: 1;
  /** Unique envelope identifier */
  id: string;
  /** Run that produced this response */
  runId: string;
  /** Agent identity claims at time of execution */
  identity: AgentIdentityClaims;
  /** Integrity binding at time of execution */
  integrity: AgentIntegrityBinding;
  /** The agent's output text */
  output: string;
  /** Structured output metadata (if any) */
  outputMetadata?: Record<string, unknown>;
  /** Model used for generation */
  model: string;
  /** Provider name */
  provider: string;
  /** SHA-256 hash of the output content */
  outputHash: string;
  /** SHA-256 hash of the full envelope (excluding this field) */
  envelopeHash: string;
  /** Optional signature over envelopeHash */
  signature?: string;
  /** Signer identity (key ID, address, or DID) */
  signerIdentity?: string;
  /** Timestamp when envelope was assembled */
  assembledAt: number;
  /** Policy decisions that governed this run */
  policySnapshot?: PolicyEnvelopeEntry[];
  /** Provider-signed response hash (when provider supports it) */
  providerResponseHash?: string;
  /** Provider signature (future: provider-signed envelopes) */
  providerSignature?: string;
}

/** Compact policy decision reference for embedding in envelopes. */
export interface PolicyEnvelopeEntry {
  /** Rule ID that was evaluated */
  ruleId: string;
  /** Final verdict */
  verdict: string;
  /** Risk score 0-100 */
  riskScore: number;
  /** Evaluation timestamp */
  evaluatedAt: number;
}
