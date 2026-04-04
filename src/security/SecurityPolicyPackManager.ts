/**
 * @packageDocumentation
 * @module SecurityPolicyPackManager
 * @description
 * Manages registration and lifecycle of SecurityPolicyPack bundles.
 * When a pack is registered, its rules are added to the PolicyEngine
 * and its hooks are added to the HookRegistry. Removal is atomic.
 */

import type { PolicyEngine } from '../policy/PolicyEngine';
import type { HookRegistry } from '../hooks/HookRegistry';
import type { SecurityPolicyPack, SecurityPackManagerOptions } from './types';

export class SecurityPolicyPackManager {
  private packs = new Map<string, SecurityPolicyPack>();
  private options: Required<SecurityPackManagerOptions>;

  constructor(
    private policyEngine: PolicyEngine,
    private hookRegistry: HookRegistry,
    options?: SecurityPackManagerOptions,
  ) {
    this.options = {
      traceRegistration: options?.traceRegistration ?? false,
    };
  }

  /** Register a security policy pack. Rules → PolicyEngine, Hooks → HookRegistry. */
  registerPack(pack: SecurityPolicyPack): void {
    if (this.packs.has(pack.id)) {
      throw new Error(`Security pack '${pack.id}' is already registered`);
    }
    // Add rules to policy engine
    for (const rule of pack.rules) {
      this.policyEngine.register(rule);
    }
    // Add hooks to hook registry
    for (const hook of pack.hooks) {
      this.hookRegistry.register(hook);
    }
    this.packs.set(pack.id, pack);
  }

  /** Remove a security policy pack. Atomically removes all its rules and hooks. */
  removePack(packId: string): boolean {
    const pack = this.packs.get(packId);
    if (!pack) return false;
    // Remove rules
    for (const rule of pack.rules) {
      this.policyEngine.remove(rule.id);
    }
    // Remove hooks
    for (const hook of pack.hooks) {
      this.hookRegistry.remove(hook.name);
    }
    this.packs.delete(packId);
    return true;
  }

  /** Get a registered pack by ID. */
  getPack(packId: string): SecurityPolicyPack | undefined {
    return this.packs.get(packId);
  }

  /** List all registered packs. */
  listPacks(): SecurityPolicyPack[] {
    return Array.from(this.packs.values());
  }

  /** Check if a pack is registered. */
  hasPack(packId: string): boolean {
    return this.packs.has(packId);
  }

  /** Remove all packs. */
  clear(): void {
    for (const packId of Array.from(this.packs.keys())) {
      this.removePack(packId);
    }
  }
}
