/**
 * @packageDocumentation
 * @module TransportHardeningTypes
 * @description
 * Durability, policy, and provenance types for remote transport calls.
 * Defines retry semantics, circuit breaker state, auth policies, endpoint
 * allowlists, capability manifests, and remote call provenance records.
 */

import type { TransportAuthConfig } from './Transports';

// ── Retry Policy ──

export interface RetryPolicy {
  /** Maximum number of retry attempts (0 = no retries). */
  maxRetries: number;
  /** Base delay in ms before first retry. */
  backoffMs: number;
  /** Multiplier applied to backoff after each retry. */
  backoffMultiplier: number;
  /** Upper bound on any single backoff delay. */
  maxBackoffMs: number;
  /** Whether to add random jitter (0–backoff) to each delay. */
  jitter: boolean;
  /** HTTP status codes or error names that are retryable. */
  retryableErrors?: Array<number | string>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: 500,
  backoffMultiplier: 2,
  maxBackoffMs: 10_000,
  jitter: true,
};

// ── Timeout Policy ──

export interface TimeoutPolicy {
  /** Per-request timeout in ms. */
  requestTimeoutMs: number;
  /** Absolute deadline in epoch ms (0 = no deadline). */
  deadlineMs?: number;
}

export const DEFAULT_TIMEOUT_POLICY: TimeoutPolicy = {
  requestTimeoutMs: 30_000,
};

// ── Circuit Breaker ──

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit. */
  failureThreshold: number;
  /** Time in ms to remain open before transitioning to half-open. */
  resetTimeoutMs: number;
  /** Max probe requests allowed in half-open state. */
  halfOpenMaxProbes: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxProbes: 1,
};

// ── Transport Policy ──

export interface TransportEndpointPolicy {
  /** Glob or exact endpoint patterns that are allowed. Empty = allow all. */
  allowedEndpoints: string[];
  /** Glob or exact endpoint patterns that are blocked (takes precedence). */
  blockedEndpoints: string[];
}

export interface TransportPolicy {
  /** Auth configuration for this policy scope. */
  auth?: TransportAuthConfig;
  /** Timeout enforcement. */
  timeout?: TimeoutPolicy;
  /** Retry strategy. */
  retry?: RetryPolicy;
  /** Circuit breaker configuration. */
  circuitBreaker?: CircuitBreakerConfig;
  /** Endpoint allowlist/blocklist. */
  endpoints?: TransportEndpointPolicy;
  /** Maximum spend in USD per remote call (0 = no limit). */
  maxCallCostUSD?: number;
}

// ── Capability Manifest ──

export interface CapabilityManifest {
  /** Capability name (must be unique within a registry). */
  name: string;
  /** Semantic version of this capability. */
  version: string;
  /** Human-readable description. */
  description: string;
  /** Protocol this capability is exposed over. */
  protocol: 'mcp' | 'acp' | 'a2a' | 'local';
  /** Remote endpoint when protocol is not local. */
  endpoint?: string;
  /** Input schema for validation. */
  inputSchema?: Record<string, unknown>;
  /** Output schema for validation. */
  outputSchema?: Record<string, unknown>;
  /** Auth requirements for invoking this capability. */
  authRequirements?: {
    type: 'bearer' | 'api-key' | 'none';
    scopes?: string[];
  };
  /** Cost estimate range. */
  costEstimate?: { minUSD: number; maxUSD: number };
  /** Transport policy overrides for this specific capability. */
  transportPolicy?: Partial<TransportPolicy>;
  /** Tags for discovery/filtering. */
  tags?: string[];
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

// ── Remote Call Provenance ──

export type RemoteCallOutcome = 'success' | 'failure' | 'timeout' | 'circuit-open' | 'policy-denied' | 'retried';

export interface RemoteCallRecord {
  /** Unique call ID. */
  callId: string;
  /** Capability name invoked. */
  capability: string;
  /** Protocol used. */
  protocol: 'mcp' | 'acp' | 'a2a';
  /** Target endpoint. */
  endpoint: string;
  /** Caller agent ID. */
  callerAgentId: string;
  /** Run ID of the calling agent. */
  callerRunId: string;
  /** Outcome of the call. */
  outcome: RemoteCallOutcome;
  /** Number of attempts (1 = no retries). */
  attempts: number;
  /** Start time (epoch ms). */
  startedAt: number;
  /** Duration in ms. */
  durationMs: number;
  /** Cost incurred (if reported). */
  costUSD?: number;
  /** Error message on failure. */
  error?: string;
  /** HTTP status code of final attempt. */
  httpStatus?: number;
  /** Circuit breaker state at time of call. */
  circuitState?: CircuitBreakerState;
  /** Auth method used. */
  authMethod?: 'bearer' | 'api-key' | 'none';
}

// ── Policy Evaluation Result ──

export interface PolicyEvaluationResult {
  /** Whether the call is allowed to proceed. */
  allowed: boolean;
  /** Reason for denial (when allowed = false). */
  reason?: string;
  /** Effective auth config to use (may override transport default). */
  effectiveAuth?: TransportAuthConfig;
  /** Effective timeout to apply. */
  effectiveTimeout?: TimeoutPolicy;
  /** Effective retry to apply. */
  effectiveRetry?: RetryPolicy;
}
