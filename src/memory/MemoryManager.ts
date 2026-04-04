/**
 * @packageDocumentation
 * @module MemoryManager
 * @description
 * Manages memory across tiers with a unified API.
 * Delegates to a MemoryStore backend.
 */

import type {
  MemoryStore,
  MemoryEntry,
  MemoryWriteRequest,
  MemoryQuery,
  MemoryConfig,
  MemoryScope,
  MemoryTier,
  MemoryEntryKind,
} from '../types/memory';
import { InMemoryStore } from './InMemoryStore';

export class MemoryManager {
  private store: MemoryStore;
  private config: MemoryConfig;

  constructor(config?: MemoryConfig) {
    this.config = config ?? {};
    this.store = config?.store ?? new InMemoryStore();
  }

  /** Read a memory entry by ID. */
  async read(id: string): Promise<MemoryEntry | null> {
    return this.store.read(id);
  }

  /** Write a memory entry. */
  async write(request: MemoryWriteRequest): Promise<MemoryEntry> {
    const tier = request.entry.tier;
    if (!this.isTierEnabled(tier)) {
      throw new Error(`Memory tier '${tier}' is not enabled`);
    }
    return this.store.write(request);
  }

  /** Search memory. */
  async search(query: MemoryQuery): Promise<MemoryEntry[]> {
    return this.store.search(query);
  }

  /** Search memory by logical classification. */
  async searchByKind(kind: MemoryEntryKind, query: Omit<MemoryQuery, 'kind'> = {}): Promise<MemoryEntry[]> {
    return this.store.search({ ...query, kind });
  }

  /** Delete a memory entry. */
  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  /** Get working memory (current turn/run context). */
  async getWorkingMemory(runId?: string): Promise<MemoryEntry[]> {
    return this.store.search({
      tier: 'working',
      scope: runId ? 'run' : undefined,
    });
  }

  /** Get episodic memory (past interactions). */
  async getEpisodicMemory(limit?: number): Promise<MemoryEntry[]> {
    return this.store.search({ tier: 'episodic', limit });
  }

  /** Get semantic memory (facts). */
  async getSemanticMemory(query?: string, limit?: number): Promise<MemoryEntry[]> {
    return this.store.search({ tier: 'semantic', text: query, limit });
  }

  /** Get procedural memory (learned procedures). */
  async getProceduralMemory(tags?: string[]): Promise<MemoryEntry[]> {
    return this.store.search({ tier: 'procedural', tags });
  }

  /** Get references to authoritative workspace state. */
  async getWorkspaceState(options?: {
    resourceType?: string;
    resourceId?: string;
    limit?: number;
  }): Promise<MemoryEntry[]> {
    return this.store.search({
      kind: 'workspace_state',
      resourceType: options?.resourceType,
      resourceId: options?.resourceId,
      limit: options?.limit,
    });
  }

  /** Get derived summaries or extracted memories. */
  async getDerivedMemory(limit?: number): Promise<MemoryEntry[]> {
    return this.store.search({ kind: 'derived_memory', limit });
  }

  /** Get evidence-linked memory entries. */
  async getEvidenceEntries(limit?: number): Promise<MemoryEntry[]> {
    return this.store.search({ kind: 'evidence', limit });
  }

  /** Compact memory across all tiers. */
  async compact() {
    return this.store.compact({
      maxPerTier: this.getMaxPerTier(),
    });
  }

  /** Clear memory by scope. */
  async clear(scope?: MemoryScope): Promise<void> {
    return this.store.clear(scope);
  }

  /** Check if a tier is enabled. */
  private isTierEnabled(tier: MemoryTier): boolean {
    switch (tier) {
      case 'working':
        return this.config.working !== false;
      case 'episodic':
        return this.config.episodic?.enabled !== false;
      case 'semantic':
        return this.config.semantic?.enabled !== false;
      case 'procedural':
        return this.config.procedural?.enabled !== false;
      default:
        return true;
    }
  }

  /** Get max entries per tier (for compaction). */
  private getMaxPerTier(): number {
    // Use the largest configured max, or default
    const maxes = [
      this.config.episodic?.maxEntries,
      this.config.semantic?.maxEntries,
      this.config.procedural?.maxEntries,
    ].filter((m): m is number => m !== undefined);

    return maxes.length > 0 ? Math.max(...maxes) : 1000;
  }
}
