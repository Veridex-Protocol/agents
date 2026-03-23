/**
 * @packageDocumentation
 * @module CheckpointManager
 * @description
 * Manages run checkpoints for suspend/resume and fault recovery.
 */

export interface Checkpoint {
  /** Checkpoint ID */
  id: string;
  /** Run ID */
  runId: string;
  /** Agent ID */
  agentId: string;
  /** Turn index at checkpoint time */
  turnIndex: number;
  /** Serialized run state */
  state: string;
  /** Timestamp */
  createdAt: number;
  /** Checkpoint reason */
  reason: 'suspend' | 'approval' | 'handoff' | 'periodic' | 'error';
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Interface for checkpoint storage backends. */
export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  load(id: string): Promise<Checkpoint | null>;
  loadLatest(runId: string): Promise<Checkpoint | null>;
  list(runId: string): Promise<Checkpoint[]>;
  delete(id: string): Promise<boolean>;
  clear(runId?: string): Promise<void>;
}

export class CheckpointManager {
  private store: CheckpointStore;
  private counter = 0;

  constructor(store?: CheckpointStore) {
    this.store = store ?? new InMemoryCheckpointStore();
  }

  /** Create a checkpoint of the current run state. */
  async save(
    runId: string,
    agentId: string,
    turnIndex: number,
    state: Record<string, unknown>,
    reason: Checkpoint['reason'] = 'periodic',
    metadata?: Record<string, unknown>,
  ): Promise<Checkpoint> {
    const checkpoint: Checkpoint = {
      id: `ckpt_${++this.counter}_${Date.now()}`,
      runId,
      agentId,
      turnIndex,
      state: JSON.stringify(state),
      createdAt: Date.now(),
      reason,
      metadata,
    };

    await this.store.save(checkpoint);
    return checkpoint;
  }

  /** Load a specific checkpoint. */
  async load(id: string): Promise<Checkpoint | null> {
    return this.store.load(id);
  }

  /** Load the latest checkpoint for a run. */
  async loadLatest(runId: string): Promise<Checkpoint | null> {
    return this.store.loadLatest(runId);
  }

  /** List all checkpoints for a run. */
  async list(runId: string): Promise<Checkpoint[]> {
    return this.store.list(runId);
  }

  /** Delete a checkpoint. */
  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  /** Clear all checkpoints (optionally for a specific run). */
  async clear(runId?: string): Promise<void> {
    return this.store.clear(runId);
  }

  /** Parse checkpoint state back to an object. */
  parseState(checkpoint: Checkpoint): Record<string, unknown> {
    return JSON.parse(checkpoint.state) as Record<string, unknown>;
  }
}

/** In-memory checkpoint store implementation. */
export class InMemoryCheckpointStore implements CheckpointStore {
  private checkpoints = new Map<string, Checkpoint>();

  async save(checkpoint: Checkpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, { ...checkpoint });
  }

  async load(id: string): Promise<Checkpoint | null> {
    const cp = this.checkpoints.get(id);
    return cp ? { ...cp } : null;
  }

  async loadLatest(runId: string): Promise<Checkpoint | null> {
    let latest: Checkpoint | null = null;
    for (const cp of this.checkpoints.values()) {
      if (cp.runId === runId) {
        if (!latest || cp.createdAt > latest.createdAt) {
          latest = cp;
        }
      }
    }
    return latest ? { ...latest } : null;
  }

  async list(runId: string): Promise<Checkpoint[]> {
    const results: Checkpoint[] = [];
    for (const cp of this.checkpoints.values()) {
      if (cp.runId === runId) {
        results.push({ ...cp });
      }
    }
    return results.sort((a, b) => a.createdAt - b.createdAt);
  }

  async delete(id: string): Promise<boolean> {
    return this.checkpoints.delete(id);
  }

  async clear(runId?: string): Promise<void> {
    if (!runId) {
      this.checkpoints.clear();
      return;
    }
    for (const [id, cp] of this.checkpoints) {
      if (cp.runId === runId) {
        this.checkpoints.delete(id);
      }
    }
  }
}
