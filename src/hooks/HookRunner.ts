/**
 * @packageDocumentation
 * @module HookRunner
 * @description
 * Executes hooks for a given phase with timeout, fault isolation,
 * and short-circuit override support.
 */

import type { HookPhase, RuntimeHook, HookResult, HookOverride } from '../types/hooks';
import type { HookRegistry } from './HookRegistry';

export interface HookRunResult {
  /** Combined annotations from all hooks */
  annotations: Record<string, unknown>;
  /** Final override (most restrictive wins) */
  override: HookOverride;
  /** Reasons from hooks that issued overrides */
  reasons: string[];
  /** Errors from hooks that threw (non-blocking) */
  errors: Array<{ hookName: string; error: Error }>;
}

/** Override severity ranking (higher = more restrictive). */
const OVERRIDE_SEVERITY: Record<HookOverride, number> = {
  continue: 0,
  retry: 1,
  pause: 2,
  deny: 3,
};

export class HookRunner {
  constructor(private registry: HookRegistry) {}

  /** Run all hooks for a phase, returning the combined result. */
  async run(phase: HookPhase, context: unknown): Promise<HookRunResult> {
    const hooks = this.registry.getForPhase(phase);
    const result: HookRunResult = {
      annotations: {},
      override: 'continue',
      reasons: [],
      errors: [],
    };

    for (const hook of hooks) {
      try {
        const hookResult = await this.executeWithTimeout(hook, context);
        if (hookResult) {
          this.mergeResult(result, hookResult, hook.name);
        }
        // Short-circuit on deny
        if (result.override === 'deny') break;
      } catch (err) {
        result.errors.push({
          hookName: hook.name,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    return result;
  }

  private async executeWithTimeout(
    hook: RuntimeHook,
    context: unknown,
  ): Promise<HookResult | void> {
    const timeoutMs = hook.timeoutMs ?? 5000;

    return new Promise<HookResult | void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Hook '${hook.name}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      Promise.resolve(hook.execute(context))
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private mergeResult(combined: HookRunResult, hookResult: HookResult, hookName: string): void {
    // Merge annotations
    if (hookResult.annotations) {
      Object.assign(combined.annotations, hookResult.annotations);
    }

    // Apply most restrictive override
    if (hookResult.override) {
      const currentSeverity = OVERRIDE_SEVERITY[combined.override];
      const newSeverity = OVERRIDE_SEVERITY[hookResult.override];
      if (newSeverity > currentSeverity) {
        combined.override = hookResult.override;
      }
      if (hookResult.reason) {
        combined.reasons.push(`[${hookName}] ${hookResult.reason}`);
      }
    }
  }
}
