/**
 * @packageDocumentation
 * @module TransportPolicyEvaluator
 * @description
 * Evaluates transport policies (auth, endpoints, timeout, retry, cost) before
 * a remote call is dispatched. Returns a PolicyEvaluationResult that gates
 * execution and supplies effective configuration.
 */

import type {
  CapabilityManifest,
  PolicyEvaluationResult,
  TransportPolicy,
} from './types';
import type { TransportAuthConfig } from './Transports';

export interface TransportPolicyEvaluatorOptions {
  /** Global default policy applied when no capability-specific policy exists. */
  defaultPolicy?: TransportPolicy;
}

/**
 * Evaluates whether a remote call should proceed based on layered transport policies.
 *
 * Policy resolution order (last wins):
 *   1. Global default policy
 *   2. Capability manifest's transportPolicy override
 */
export class TransportPolicyEvaluator {
  private readonly defaultPolicy: TransportPolicy;

  constructor(options?: TransportPolicyEvaluatorOptions) {
    this.defaultPolicy = options?.defaultPolicy ?? {};
  }

  /**
   * Evaluate whether a call to `endpoint` for `manifest` is allowed.
   * Returns the merged effective config for timeout/retry/auth.
   */
  evaluate(
    endpoint: string,
    manifest?: CapabilityManifest,
  ): PolicyEvaluationResult {
    const merged = this.mergePolicy(this.defaultPolicy, manifest?.transportPolicy);

    // Endpoint allowlist/blocklist check
    if (merged.endpoints) {
      if (this.isBlocked(endpoint, merged.endpoints.blockedEndpoints)) {
        return { allowed: false, reason: `Endpoint blocked by policy: ${endpoint}` };
      }
      if (
        merged.endpoints.allowedEndpoints.length > 0
        && !this.isAllowed(endpoint, merged.endpoints.allowedEndpoints)
      ) {
        return { allowed: false, reason: `Endpoint not in allowlist: ${endpoint}` };
      }
    }

    // Auth resolution
    const effectiveAuth = this.resolveAuth(merged.auth, manifest);

    return {
      allowed: true,
      effectiveAuth,
      effectiveTimeout: merged.timeout,
      effectiveRetry: merged.retry,
    };
  }

  private mergePolicy(
    base: TransportPolicy,
    override?: Partial<TransportPolicy>,
  ): TransportPolicy {
    if (!override) return base;
    return {
      auth: override.auth ?? base.auth,
      timeout: override.timeout
        ? { ...base.timeout, ...override.timeout }
        : base.timeout,
      retry: override.retry
        ? { ...base.retry, ...override.retry }
        : base.retry,
      circuitBreaker: override.circuitBreaker
        ? { ...base.circuitBreaker, ...override.circuitBreaker }
        : base.circuitBreaker,
      endpoints: override.endpoints ?? base.endpoints,
      maxCallCostUSD: override.maxCallCostUSD ?? base.maxCallCostUSD,
    };
  }

  private resolveAuth(
    policyAuth?: TransportAuthConfig,
    manifest?: CapabilityManifest,
  ): TransportAuthConfig | undefined {
    // Policy-level auth takes precedence
    if (policyAuth) return policyAuth;

    // Fall back to manifest auth requirements (no token — caller must supply later)
    if (manifest?.authRequirements?.type && manifest.authRequirements.type !== 'none') {
      return {
        type: manifest.authRequirements.type,
        token: '', // placeholder — caller must inject real token
      };
    }

    return undefined;
  }

  private isBlocked(endpoint: string, blocked: string[]): boolean {
    return blocked.some((pattern) => this.matchEndpoint(endpoint, pattern));
  }

  private isAllowed(endpoint: string, allowed: string[]): boolean {
    return allowed.some((pattern) => this.matchEndpoint(endpoint, pattern));
  }

  /**
   * Simple endpoint matching: exact match or glob-style wildcard suffix.
   * e.g., "https://api.example.com/*" matches any path under that origin.
   */
  private matchEndpoint(endpoint: string, pattern: string): boolean {
    if (pattern === endpoint) return true;
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return endpoint.startsWith(prefix);
    }
    return false;
  }
}
