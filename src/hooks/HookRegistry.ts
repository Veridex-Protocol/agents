/**
 * @packageDocumentation
 * @module HookRegistry
 * @description
 * Registry for runtime lifecycle hooks. Manages registration and lookup by phase.
 */

import type { HookPhase, RuntimeHook } from '../types/hooks';

export class HookRegistry {
  private hooks = new Map<HookPhase, RuntimeHook[]>();

  /** Register a hook. */
  register(hook: RuntimeHook): void {
    const existing = this.hooks.get(hook.phase) ?? [];
    existing.push(hook);
    // Sort by priority (lower = runs first)
    existing.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    this.hooks.set(hook.phase, existing);
  }

  /** Get all hooks for a phase, sorted by priority. */
  getForPhase(phase: HookPhase): RuntimeHook[] {
    return this.hooks.get(phase) ?? [];
  }

  /** Remove a hook by name. */
  remove(name: string): boolean {
    let found = false;
    for (const [phase, hooks] of this.hooks) {
      const filtered = hooks.filter((h) => h.name !== name);
      if (filtered.length !== hooks.length) {
        found = true;
        this.hooks.set(phase, filtered);
      }
    }
    return found;
  }

  /** List all registered hook names. */
  list(): string[] {
    const names = new Set<string>();
    for (const hooks of this.hooks.values()) {
      for (const h of hooks) names.add(h.name);
    }
    return Array.from(names);
  }

  /** Clear all hooks. */
  clear(): void {
    this.hooks.clear();
  }
}
