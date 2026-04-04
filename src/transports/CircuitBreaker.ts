/**
 * @packageDocumentation
 * @module CircuitBreaker
 * @description
 * Per-endpoint circuit breaker with closed → open → half-open state transitions.
 */

import type { CircuitBreakerConfig, CircuitBreakerState } from './types';
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from './types';

export interface CircuitBreakerSnapshot {
  endpoint: string;
  state: CircuitBreakerState;
  failures: number;
  lastFailureAt: number;
  openedAt: number;
  halfOpenProbes: number;
}

/**
 * Tracks failure state for a single endpoint and gates execution.
 */
class EndpointBreaker {
  state: CircuitBreakerState = 'closed';
  failures = 0;
  lastFailureAt = 0;
  openedAt = 0;
  halfOpenProbes = 0;

  constructor(private readonly config: CircuitBreakerConfig) {}

  canExecute(now: number): boolean {
    switch (this.state) {
      case 'closed':
        return true;
      case 'open':
        if (now - this.openedAt >= this.config.resetTimeoutMs) {
          this.state = 'half-open';
          this.halfOpenProbes = 0;
          return true;
        }
        return false;
      case 'half-open':
        return this.halfOpenProbes < this.config.halfOpenMaxProbes;
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.halfOpenProbes = 0;
    this.state = 'closed';
  }

  recordFailure(now: number): void {
    this.failures++;
    this.lastFailureAt = now;

    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = now;
      return;
    }

    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
      this.openedAt = now;
    }
  }

  recordProbe(): void {
    this.halfOpenProbes++;
  }
}

/**
 * Circuit breaker registry — manages per-endpoint breaker state.
 *
 * Usage:
 * ```ts
 * const cb = new CircuitBreaker();
 * if (!cb.canExecute('https://api.example.com')) {
 *   // fast-fail
 * }
 * try {
 *   const result = await callEndpoint(...);
 *   cb.recordSuccess('https://api.example.com');
 * } catch {
 *   cb.recordFailure('https://api.example.com');
 * }
 * ```
 */
export class CircuitBreaker {
  private readonly breakers = new Map<string, EndpointBreaker>();
  private readonly config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  private getBreaker(endpoint: string): EndpointBreaker {
    let breaker = this.breakers.get(endpoint);
    if (!breaker) {
      breaker = new EndpointBreaker(this.config);
      this.breakers.set(endpoint, breaker);
    }
    return breaker;
  }

  /** Check if the endpoint circuit allows execution. */
  canExecute(endpoint: string): boolean {
    return this.getBreaker(endpoint).canExecute(Date.now());
  }

  /** Record a successful call — resets the breaker to closed. */
  recordSuccess(endpoint: string): void {
    this.getBreaker(endpoint).recordSuccess();
  }

  /** Record a failed call — increments failure count or opens circuit. */
  recordFailure(endpoint: string): void {
    this.getBreaker(endpoint).recordFailure(Date.now());
  }

  /** Record that a half-open probe was dispatched. */
  recordProbe(endpoint: string): void {
    this.getBreaker(endpoint).recordProbe();
  }

  /** Get the current state of a specific endpoint's breaker. */
  getState(endpoint: string): CircuitBreakerState {
    return this.getBreaker(endpoint).state;
  }

  /** Snapshot all tracked endpoints. */
  snapshot(): CircuitBreakerSnapshot[] {
    const entries: CircuitBreakerSnapshot[] = [];
    for (const [endpoint, breaker] of this.breakers) {
      entries.push({
        endpoint,
        state: breaker.state,
        failures: breaker.failures,
        lastFailureAt: breaker.lastFailureAt,
        openedAt: breaker.openedAt,
        halfOpenProbes: breaker.halfOpenProbes,
      });
    }
    return entries;
  }

  /** Reset a specific endpoint's breaker. */
  reset(endpoint: string): void {
    this.breakers.delete(endpoint);
  }

  /** Reset all breakers. */
  resetAll(): void {
    this.breakers.clear();
  }
}
