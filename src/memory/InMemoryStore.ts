/**
 * @packageDocumentation
 * @module InMemoryStore
 * @description
 * In-memory implementation of the MemoryStore interface.
 * Suitable for development, testing, and single-run scenarios.
 */

import type {
  MemoryStore,
  MemoryEntry,
  MemoryWriteRequest,
  MemoryQuery,
  MemoryScope,
  CompactOptions,
  CompactResult,
} from '../types/memory';

export class InMemoryStore implements MemoryStore {
  private entries = new Map<string, MemoryEntry>();
  private counter = 0;

  async read(id: string): Promise<MemoryEntry | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;

    // Check TTL
    if (entry.ttlMs > 0 && Date.now() - entry.createdAt > entry.ttlMs) {
      this.entries.delete(id);
      return null;
    }

    // Update last accessed
    entry.lastAccessedAt = Date.now();
    return { ...entry };
  }

  async write(request: MemoryWriteRequest): Promise<MemoryEntry> {
    const { entry: partial, overwriteStrategy } = request;

    // Check for existing entry with same content
    if (overwriteStrategy !== 'replace') {
      for (const existing of this.entries.values()) {
        if (existing.content === partial.content && existing.tier === partial.tier) {
          switch (overwriteStrategy) {
            case 'skip':
              return { ...existing };
            case 'merge':
              existing.confidence = Math.max(existing.confidence, partial.confidence);
              existing.tags = [...new Set([...existing.tags, ...partial.tags])];
              existing.kind = partial.kind ?? existing.kind;
              existing.stateRef = partial.stateRef ?? existing.stateRef;
              existing.evidenceRef = partial.evidenceRef ?? existing.evidenceRef;
              existing.derivation = partial.derivation ?? existing.derivation;
              existing.lastAccessedAt = Date.now();
              return { ...existing };
            case 'append':
              break; // Fall through to create new
          }
        }
      }
    }

    const now = Date.now();
    const entry: MemoryEntry = {
      ...partial,
      id: `mem_${++this.counter}_${now}`,
      createdAt: now,
      lastAccessedAt: now,
    };

    this.entries.set(entry.id, entry);
    return { ...entry };
  }

  async search(query: MemoryQuery): Promise<MemoryEntry[]> {
    const now = Date.now();
    let results: MemoryEntry[] = [];

    for (const entry of this.entries.values()) {
      // Skip expired
      if (entry.ttlMs > 0 && now - entry.createdAt > entry.ttlMs) continue;

      // Filter by tier
      if (query.tier && entry.tier !== query.tier) continue;

      // Filter by kind
      if (query.kind && entry.kind !== query.kind) continue;

      // Filter by scope
      if (query.scope && entry.scope !== query.scope) continue;

      // Filter by referenced workspace resource
      if (query.resourceType && entry.stateRef?.resourceType !== query.resourceType) continue;
      if (query.resourceId && entry.stateRef?.resourceId !== query.resourceId) continue;

      // Filter by min confidence
      if (query.minConfidence !== undefined && entry.confidence < query.minConfidence) continue;

      // Filter by newer than
      if (query.newerThan !== undefined && entry.createdAt < query.newerThan) continue;

      // Filter by tags (any match)
      if (query.tags?.length) {
        const hasTags = query.tags.some((t) => entry.tags.includes(t));
        if (!hasTags) continue;
      }

      // Filter by text search (simple substring)
      if (query.text) {
        const lowerText = query.text.toLowerCase();
        if (!entry.content.toLowerCase().includes(lowerText)) continue;
      }

      results.push({ ...entry });
    }

    // Sort by recency (newest first)
    results.sort((a, b) => b.createdAt - a.createdAt);

    // Apply limit
    if (query.limit !== undefined) {
      results = results.slice(0, query.limit);
    }

    // Update last accessed
    for (const entry of results) {
      const original = this.entries.get(entry.id);
      if (original) original.lastAccessedAt = now;
    }

    return results;
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async compact(options?: CompactOptions): Promise<CompactResult> {
    const now = Date.now();
    let removed = 0;

    for (const [id, entry] of this.entries) {
      let shouldRemove = false;

      // Remove expired
      if (entry.ttlMs > 0 && now - entry.createdAt > entry.ttlMs) {
        shouldRemove = true;
      }

      // Remove older than
      if (options?.olderThan && entry.createdAt < options.olderThan) {
        shouldRemove = true;
      }

      // Remove below confidence
      if (options?.belowConfidence !== undefined && entry.confidence < options.belowConfidence) {
        shouldRemove = true;
      }

      if (shouldRemove) {
        this.entries.delete(id);
        removed++;
      }
    }

    // Enforce max per tier
    if (options?.maxPerTier) {
      const byTier = new Map<string, MemoryEntry[]>();
      for (const entry of this.entries.values()) {
        const list = byTier.get(entry.tier) ?? [];
        list.push(entry);
        byTier.set(entry.tier, list);
      }

      for (const [, entries] of byTier) {
        if (entries.length > options.maxPerTier) {
          entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
          const toRemove = entries.slice(0, entries.length - options.maxPerTier);
          for (const entry of toRemove) {
            this.entries.delete(entry.id);
            removed++;
          }
        }
      }
    }

    return { removed, merged: 0, archived: 0 };
  }

  async clear(scope?: MemoryScope): Promise<void> {
    if (!scope) {
      this.entries.clear();
      return;
    }

    for (const [id, entry] of this.entries) {
      if (entry.scope === scope) {
        this.entries.delete(id);
      }
    }
  }

  /** Get total entry count (for testing). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * In-place patch of an entry's mutable fields. Returns the updated
   * entry or null if the id is unknown. Used by `MemoryLifecycle` for
   * decay, promotion, and confidence adjustments without changing IDs.
   */
  async update(
    id: string,
    patch: Partial<
      Pick<MemoryEntry, 'tier' | 'confidence' | 'tags' | 'metadata' | 'derivation' | 'ttlMs' | 'content'>
    >,
  ): Promise<MemoryEntry | null> {
    const existing = this.entries.get(id);
    if (!existing) return null;
    if (patch.tier !== undefined) existing.tier = patch.tier;
    if (patch.confidence !== undefined) existing.confidence = patch.confidence;
    if (patch.tags !== undefined) existing.tags = [...patch.tags];
    if (patch.metadata !== undefined) existing.metadata = { ...patch.metadata };
    if (patch.derivation !== undefined) existing.derivation = patch.derivation;
    if (patch.ttlMs !== undefined) existing.ttlMs = patch.ttlMs;
    if (patch.content !== undefined) existing.content = patch.content;
    existing.lastAccessedAt = Date.now();
    return { ...existing };
  }
}
