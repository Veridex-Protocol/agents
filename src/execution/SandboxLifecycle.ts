/**
 * @packageDocumentation
 * @module SandboxLifecycleManager
 * @description
 * Per-session sandbox lifecycle — Phase 5 item #3.
 *
 * Why this exists:
 *   `SandboxRuntime` is the *what* (execute code) but production
 *   deployments need a *when* and *for how long*. Long-running runs
 *   want a stable sandbox across many tool calls (so the working
 *   directory persists). Suspended runs need their sandbox snapshotted
 *   so a fresh worker can restore them later. Cheap throwaway runs
 *   should release the sandbox the moment the turn ends.
 *
 * Design:
 *   - {@link SandboxLifecycleManager} owns a pool of sandboxes keyed by
 *     `sessionId`.
 *   - `acquire(sessionId)` returns the sandbox for that session,
 *     creating it if it's missing.
 *   - `snapshot(sessionId)` returns a backend-defined {@link SandboxSnapshot};
 *     `restore(snapshot)` rehydrates one (used for resume / ralph loop).
 *   - `release(sessionId)` disposes the sandbox.
 *   - Default `InMemorySandboxLifecycleManager` is backend-agnostic;
 *     it delegates `create`/`snapshot`/`restore` to a user-supplied
 *     {@link SandboxFactory}. Backends that don't support snapshots
 *     return `null` and `restore` re-creates from scratch.
 *   - The default factory wraps a `LocalProcessSandbox` for tests &
 *     local dev. Production drops in E2B / Modal / Daytona factories.
 */

import type { SandboxRuntime } from './Sandbox';

/** Opaque snapshot handle produced by a backend. */
export interface SandboxSnapshot {
  /** Stable identifier (e.g. snapshot URI, tarball path, vendor ref). */
  id: string;
  /** Backend that produced it. Used to validate restore() compatibility. */
  vendor: string;
  /** Wall-clock time the snapshot was taken. */
  createdAt: number;
  /** Free-form vendor metadata (region, version, attestation). */
  metadata?: Record<string, unknown>;
}

/** Factory that knows how to create / snapshot / restore a sandbox. */
export interface SandboxFactory {
  /** Vendor identifier; must match {@link SandboxSnapshot.vendor}. */
  readonly vendor: string;
  /** Create a fresh sandbox for `sessionId`. */
  create(sessionId: string): Promise<SandboxRuntime>;
  /** Optional snapshot support. Return `null` if unsupported. */
  snapshot?(sessionId: string, sandbox: SandboxRuntime): Promise<SandboxSnapshot | null>;
  /** Optional restore support. Throws if vendor mismatches. */
  restore?(snapshot: SandboxSnapshot): Promise<SandboxRuntime>;
}

export interface SandboxLifecycleManager {
  /** Get or create the sandbox for this session. */
  acquire(sessionId: string): Promise<SandboxRuntime>;
  /** Snapshot the session's sandbox; returns `null` when unsupported. */
  snapshot(sessionId: string): Promise<SandboxSnapshot | null>;
  /** Restore from a snapshot and bind it to `sessionId`. */
  restore(sessionId: string, snapshot: SandboxSnapshot): Promise<SandboxRuntime>;
  /** Dispose the sandbox tied to this session. */
  release(sessionId: string): Promise<void>;
  /** Tear down all sandboxes (used at shutdown). */
  releaseAll(): Promise<void>;
  /** Active session count, for metrics. */
  size(): number;
}

interface PoolEntry {
  sandbox: SandboxRuntime;
  lastTouched: number;
}

export interface InMemoryLifecycleOptions {
  /** Factory used to mint sandboxes. */
  factory: SandboxFactory;
  /** Max concurrent sandboxes. Default `Infinity`. */
  maxConcurrent?: number;
  /** Idle TTL in ms. `0` disables idle eviction. Default `0`. */
  idleTtlMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

/**
 * Default lifecycle manager. Stores sandboxes in a `Map` keyed by
 * `sessionId`. Eviction is LRU when `maxConcurrent` is hit; idle TTL
 * is checked lazily on `acquire`.
 */
export class InMemorySandboxLifecycleManager implements SandboxLifecycleManager {
  private readonly pool = new Map<string, PoolEntry>();
  private readonly factory: SandboxFactory;
  private readonly maxConcurrent: number;
  private readonly idleTtlMs: number;
  private readonly clock: () => number;

  constructor(options: InMemoryLifecycleOptions) {
    this.factory = options.factory;
    this.maxConcurrent = options.maxConcurrent ?? Infinity;
    this.idleTtlMs = options.idleTtlMs ?? 0;
    this.clock = options.now ?? (() => Date.now());
  }

  async acquire(sessionId: string): Promise<SandboxRuntime> {
    this.evictIdle();
    const existing = this.pool.get(sessionId);
    if (existing) {
      existing.lastTouched = this.clock();
      return existing.sandbox;
    }
    await this.enforceCapacity();
    const sandbox = await this.factory.create(sessionId);
    this.pool.set(sessionId, { sandbox, lastTouched: this.clock() });
    return sandbox;
  }

  async snapshot(sessionId: string): Promise<SandboxSnapshot | null> {
    const entry = this.pool.get(sessionId);
    if (!entry) {
      throw new Error(`SandboxLifecycle: no sandbox for session '${sessionId}'`);
    }
    if (!this.factory.snapshot) return null;
    return this.factory.snapshot(sessionId, entry.sandbox);
  }

  async restore(sessionId: string, snapshot: SandboxSnapshot): Promise<SandboxRuntime> {
    if (snapshot.vendor !== this.factory.vendor) {
      throw new Error(
        `SandboxLifecycle: snapshot vendor '${snapshot.vendor}' does not match factory '${this.factory.vendor}'`,
      );
    }
    if (!this.factory.restore) {
      // Restore not implemented — fall back to a fresh sandbox.
      return this.acquire(sessionId);
    }
    // Dispose any existing sandbox under this id.
    await this.release(sessionId);
    await this.enforceCapacity();
    const sandbox = await this.factory.restore(snapshot);
    this.pool.set(sessionId, { sandbox, lastTouched: this.clock() });
    return sandbox;
  }

  async release(sessionId: string): Promise<void> {
    const entry = this.pool.get(sessionId);
    if (!entry) return;
    this.pool.delete(sessionId);
    if (entry.sandbox.dispose) {
      try {
        await entry.sandbox.dispose();
      } catch {
        // Best-effort dispose. Production wrappers should log here.
      }
    }
  }

  async releaseAll(): Promise<void> {
    const ids = Array.from(this.pool.keys());
    await Promise.all(ids.map((id) => this.release(id)));
  }

  size(): number {
    return this.pool.size;
  }

  private evictIdle(): void {
    if (this.idleTtlMs <= 0) return;
    const cutoff = this.clock() - this.idleTtlMs;
    for (const [id, entry] of this.pool) {
      if (entry.lastTouched < cutoff) {
        // Fire-and-forget; release() is async but the next acquire will
        // wait on `enforceCapacity` anyway.
        void this.release(id);
      }
    }
  }

  private async enforceCapacity(): Promise<void> {
    if (this.pool.size < this.maxConcurrent) return;
    // Evict the oldest entry. Map iteration order is insertion order,
    // and we update `lastTouched` on acquire — so find the actual LRU.
    let oldestId: string | null = null;
    let oldestTouched = Infinity;
    for (const [id, entry] of this.pool) {
      if (entry.lastTouched < oldestTouched) {
        oldestTouched = entry.lastTouched;
        oldestId = id;
      }
    }
    if (oldestId !== null) {
      await this.release(oldestId);
    }
  }
}
