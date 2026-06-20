/**
 * @packageDocumentation
 * @module RetryExecutor
 * @description
 * Wraps async operations with configurable retry, exponential backoff, and jitter.
 */

import type { RetryPolicy, TimeoutPolicy } from './types';
import { DEFAULT_RETRY_POLICY, DEFAULT_TIMEOUT_POLICY } from './types';

export interface RetryExecutorOptions {
  retry?: Partial<RetryPolicy>;
  timeout?: Partial<TimeoutPolicy>;
}

export interface RetryResult<T> {
  value?: T;
  success: boolean;
  attempts: number;
  totalDurationMs: number;
  lastError?: string;
}

/**
 * Executes an async function with retry, exponential backoff, jitter, and timeout.
 */
export class RetryExecutor {
  private readonly retry: RetryPolicy;
  private readonly timeout: TimeoutPolicy;

  constructor(options?: RetryExecutorOptions) {
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options?.retry };
    this.timeout = { ...DEFAULT_TIMEOUT_POLICY, ...options?.timeout };
  }

  async execute<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    isRetryable?: (error: unknown) => boolean,
  ): Promise<RetryResult<T>> {
    const start = Date.now();
    let lastError: string | undefined;
    const maxAttempts = 1 + this.retry.maxRetries;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Check absolute deadline
      if (this.timeout.deadlineMs && Date.now() >= this.timeout.deadlineMs) {
        return {
          success: false,
          attempts: attempt - 1,
          totalDurationMs: Date.now() - start,
          lastError: 'Deadline exceeded before attempt',
        };
      }

      const controller = new AbortController();

      // Compute effective timeout respecting deadline
      let effectiveTimeoutMs = this.timeout.requestTimeoutMs;
      if (this.timeout.deadlineMs) {
        const remaining = this.timeout.deadlineMs - Date.now();
        effectiveTimeoutMs = Math.min(effectiveTimeoutMs, remaining);
      }

      const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);

      try {
        const value = await fn(controller.signal);
        clearTimeout(timer);
        return {
          value,
          success: true,
          attempts: attempt,
          totalDurationMs: Date.now() - start,
        };
      } catch (err) {
        clearTimeout(timer);
        lastError = err instanceof Error ? err.message : String(err);

        const shouldRetry = attempt < maxAttempts
          && this.isRetryableError(err, isRetryable);

        if (!shouldRetry) {
          return {
            success: false,
            attempts: attempt,
            totalDurationMs: Date.now() - start,
            lastError,
          };
        }

        // Exponential backoff with optional jitter
        const baseDelay = Math.min(
          this.retry.backoffMs * this.retry.backoffMultiplier ** (attempt - 1),
          this.retry.maxBackoffMs,
        );
        const delay = this.retry.jitter
          ? baseDelay * (0.5 + Math.random() * 0.5)
          : baseDelay;

        await this.sleep(delay);
      }
    }

    return {
      success: false,
      attempts: maxAttempts,
      totalDurationMs: Date.now() - start,
      lastError,
    };
  }

  private isRetryableError(err: unknown, custom?: (error: unknown) => boolean): boolean {
    if (custom) {
      return custom(err);
    }

    if (!this.retry.retryableErrors || this.retry.retryableErrors.length === 0) {
      // Default: retry on timeout/network errors
      if (err instanceof Error) {
        return err.name === 'AbortError'
          || err.message.includes('fetch failed')
          || err.message.includes('ECONNREFUSED')
          || err.message.includes('ETIMEDOUT');
      }
      return false;
    }

    if (err instanceof Error) {
      return this.retry.retryableErrors.some((r) =>
        typeof r === 'string' ? err.name === r || err.message.includes(r) : false,
      );
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
