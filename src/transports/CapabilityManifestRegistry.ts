/**
 * @packageDocumentation
 * @module CapabilityManifestRegistry
 * @description
 * Versioned registry for capability manifests with protocol-aware lookup,
 * tag-based filtering, and policy integration.
 */

import type { CapabilityManifest } from './types';

/**
 * Stores and queries CapabilityManifest entries.
 * Unlike ExecutionSurfaceRegistry (which holds executable capabilities),
 * this registry focuses on discovery metadata, versioning, and policy binding.
 */
export class CapabilityManifestRegistry {
  /** name → version → manifest */
  private readonly manifests = new Map<string, Map<string, CapabilityManifest>>();

  /** Register a capability manifest. Throws on duplicate name+version. */
  register(manifest: CapabilityManifest): void {
    let versions = this.manifests.get(manifest.name);
    if (!versions) {
      versions = new Map();
      this.manifests.set(manifest.name, versions);
    }
    if (versions.has(manifest.version)) {
      throw new Error(
        `Manifest '${manifest.name}' version '${manifest.version}' is already registered`,
      );
    }
    versions.set(manifest.version, manifest);
  }

  /** Get a specific version (or latest if version omitted). */
  get(name: string, version?: string): CapabilityManifest | undefined {
    const versions = this.manifests.get(name);
    if (!versions || versions.size === 0) return undefined;

    if (version) return versions.get(version);

    // Return the lexicographically highest version (semver-ish sort)
    const sorted = [...versions.keys()].sort(this.compareSemver);
    return versions.get(sorted[sorted.length - 1]);
  }

  /** Check if a manifest exists. */
  has(name: string, version?: string): boolean {
    return this.get(name, version) !== undefined;
  }

  /** Get all versions of a manifest. */
  getVersions(name: string): CapabilityManifest[] {
    const versions = this.manifests.get(name);
    if (!versions) return [];
    return [...versions.values()];
  }

  /** Get all manifests (latest version of each). */
  getAll(): CapabilityManifest[] {
    const result: CapabilityManifest[] = [];
    for (const name of this.manifests.keys()) {
      const latest = this.get(name);
      if (latest) result.push(latest);
    }
    return result;
  }

  /** Find manifests by protocol. */
  getByProtocol(protocol: CapabilityManifest['protocol']): CapabilityManifest[] {
    return this.getAll().filter((m) => m.protocol === protocol);
  }

  /** Find manifests matching any of the given tags. */
  getByTags(tags: string[]): CapabilityManifest[] {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    return this.getAll().filter((m) =>
      m.tags?.some((t) => tagSet.has(t.toLowerCase())),
    );
  }

  /** List all registered capability names. */
  list(): string[] {
    return [...this.manifests.keys()].sort();
  }

  /** Remove a manifest (all versions if version omitted). */
  remove(name: string, version?: string): boolean {
    if (!version) {
      return this.manifests.delete(name);
    }
    const versions = this.manifests.get(name);
    if (!versions) return false;
    const removed = versions.delete(version);
    if (versions.size === 0) this.manifests.delete(name);
    return removed;
  }

  /** Clear all manifests. */
  clear(): void {
    this.manifests.clear();
  }

  /** Total number of unique capability names. */
  get size(): number {
    return this.manifests.size;
  }

  /** Summary of the registry contents. */
  summary(): {
    total: number;
    byProtocol: Record<string, number>;
    names: string[];
  } {
    const all = this.getAll();
    const byProtocol: Record<string, number> = {};
    for (const m of all) {
      byProtocol[m.protocol] = (byProtocol[m.protocol] ?? 0) + 1;
    }
    return {
      total: all.length,
      byProtocol,
      names: this.list(),
    };
  }

  /**
   * Semver-ish comparison. Compares dot-separated numeric segments left-to-right.
   * Falls back to string comparison for non-numeric segments.
   */
  private compareSemver(a: string, b: string): number {
    const ap = a.split('.');
    const bp = b.split('.');
    const len = Math.max(ap.length, bp.length);
    for (let i = 0; i < len; i++) {
      const an = parseInt(ap[i] ?? '0', 10);
      const bn = parseInt(bp[i] ?? '0', 10);
      if (Number.isNaN(an) || Number.isNaN(bn)) {
        const cmp = (ap[i] ?? '').localeCompare(bp[i] ?? '');
        if (cmp !== 0) return cmp;
      } else if (an !== bn) {
        return an - bn;
      }
    }
    return 0;
  }
}
