/**
 * SemanticMemoryGraph — Phase 3.1
 *
 * A directed, typed graph layered on top of `MemoryStore`. Nodes are memory
 * entry IDs (opaque); edges carry a `kind` capturing the semantic relation
 * between two entries (relatesTo / derivedFrom / contradicts / supersedes).
 *
 * This module deliberately does NOT mutate the underlying MemoryStore; it
 * stores edges separately so any MemoryStore implementation (in-memory,
 * Postgres, etc.) can opt-in to graph semantics without schema changes.
 */

/** Semantic relations between memory entries. */
export type MemoryEdgeKind =
  | 'relatesTo'
  | 'derivedFrom'
  | 'contradicts'
  | 'supersedes';

/** A directed, typed, weighted edge between two memory entries. */
export interface MemoryEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: MemoryEdgeKind;
  /** Strength of the relation (0..1). Default 1. */
  weight: number;
  /** Wall-clock timestamp the edge was created. */
  createdAt: number;
  /** Free-form metadata (e.g., creator, reason). */
  metadata?: Record<string, unknown>;
}

/** Parameters for adding an edge. */
export interface AddEdgeInput {
  fromId: string;
  toId: string;
  kind: MemoryEdgeKind;
  weight?: number;
  metadata?: Record<string, unknown>;
}

/** Query parameters for the graph. */
export interface EdgeQuery {
  /** Restrict to edges with this source node. */
  fromId?: string;
  /** Restrict to edges with this target node. */
  toId?: string;
  /** Restrict to one or more edge kinds. */
  kinds?: MemoryEdgeKind[];
  /** Minimum weight (inclusive). */
  minWeight?: number;
  /** Limit the number of edges returned. */
  limit?: number;
}

/** Public interface — pluggable graph backend. */
export interface SemanticMemoryGraph {
  addEdge(input: AddEdgeInput): Promise<MemoryEdge>;
  removeEdge(id: string): Promise<boolean>;
  getEdge(id: string): Promise<MemoryEdge | null>;
  query(q: EdgeQuery): Promise<MemoryEdge[]>;
  /** All neighbors of `id` (both directions). */
  neighbors(id: string, kinds?: MemoryEdgeKind[]): Promise<string[]>;
  /** Remove all edges touching `id` (useful when an entry is deleted). */
  removeNode(id: string): Promise<number>;
  /** Total edge count (testing aid). */
  size(): Promise<number>;
  /** Drop everything (testing aid). */
  clear(): Promise<void>;
}

/**
 * In-memory implementation backed by Maps. Maintains forward/reverse
 * adjacency indexes so neighbor queries are O(degree) rather than O(E).
 */
export class InMemorySemanticGraph implements SemanticMemoryGraph {
  private edges = new Map<string, MemoryEdge>();
  private outIndex = new Map<string, Set<string>>(); // fromId -> edge ids
  private inIndex = new Map<string, Set<string>>(); // toId   -> edge ids
  private counter = 0;

  private nextId(): string {
    this.counter += 1;
    return `edge_${Date.now().toString(36)}_${this.counter}`;
  }

  async addEdge(input: AddEdgeInput): Promise<MemoryEdge> {
    if (!input.fromId || !input.toId) {
      throw new Error('SemanticMemoryGraph.addEdge: fromId and toId are required');
    }
    if (input.fromId === input.toId) {
      throw new Error('SemanticMemoryGraph.addEdge: self-edges are not permitted');
    }
    const weight = input.weight ?? 1;
    if (weight < 0 || weight > 1) {
      throw new Error('SemanticMemoryGraph.addEdge: weight must be in [0,1]');
    }
    const edge: MemoryEdge = {
      id: this.nextId(),
      fromId: input.fromId,
      toId: input.toId,
      kind: input.kind,
      weight,
      createdAt: Date.now(),
      metadata: input.metadata,
    };
    this.edges.set(edge.id, edge);
    this.addToIndex(this.outIndex, edge.fromId, edge.id);
    this.addToIndex(this.inIndex, edge.toId, edge.id);
    return edge;
  }

  async removeEdge(id: string): Promise<boolean> {
    const edge = this.edges.get(id);
    if (!edge) return false;
    this.edges.delete(id);
    this.outIndex.get(edge.fromId)?.delete(id);
    this.inIndex.get(edge.toId)?.delete(id);
    return true;
  }

  async getEdge(id: string): Promise<MemoryEdge | null> {
    return this.edges.get(id) ?? null;
  }

  async query(q: EdgeQuery): Promise<MemoryEdge[]> {
    // Choose the smallest candidate set for efficiency.
    let candidateIds: Iterable<string>;
    if (q.fromId !== undefined) {
      candidateIds = this.outIndex.get(q.fromId) ?? [];
    } else if (q.toId !== undefined) {
      candidateIds = this.inIndex.get(q.toId) ?? [];
    } else {
      candidateIds = this.edges.keys();
    }
    const kinds = q.kinds ? new Set(q.kinds) : undefined;
    const out: MemoryEdge[] = [];
    for (const id of candidateIds) {
      const e = this.edges.get(id);
      if (!e) continue;
      if (q.fromId !== undefined && e.fromId !== q.fromId) continue;
      if (q.toId !== undefined && e.toId !== q.toId) continue;
      if (kinds && !kinds.has(e.kind)) continue;
      if (q.minWeight !== undefined && e.weight < q.minWeight) continue;
      out.push(e);
      if (q.limit !== undefined && out.length >= q.limit) break;
    }
    return out;
  }

  async neighbors(id: string, kinds?: MemoryEdgeKind[]): Promise<string[]> {
    const k = kinds ? new Set(kinds) : undefined;
    const result = new Set<string>();
    for (const eid of this.outIndex.get(id) ?? []) {
      const e = this.edges.get(eid);
      if (!e) continue;
      if (k && !k.has(e.kind)) continue;
      result.add(e.toId);
    }
    for (const eid of this.inIndex.get(id) ?? []) {
      const e = this.edges.get(eid);
      if (!e) continue;
      if (k && !k.has(e.kind)) continue;
      result.add(e.fromId);
    }
    return Array.from(result);
  }

  async removeNode(id: string): Promise<number> {
    const ids = new Set<string>([
      ...(this.outIndex.get(id) ?? []),
      ...(this.inIndex.get(id) ?? []),
    ]);
    let removed = 0;
    for (const eid of ids) {
      if (await this.removeEdge(eid)) removed += 1;
    }
    this.outIndex.delete(id);
    this.inIndex.delete(id);
    return removed;
  }

  async size(): Promise<number> {
    return this.edges.size;
  }

  async clear(): Promise<void> {
    this.edges.clear();
    this.outIndex.clear();
    this.inIndex.clear();
  }

  private addToIndex(index: Map<string, Set<string>>, key: string, value: string): void {
    let set = index.get(key);
    if (!set) {
      set = new Set<string>();
      index.set(key, set);
    }
    set.add(value);
  }
}
