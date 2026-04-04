import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryManager } from '../src/memory/MemoryManager';
import { InMemoryStore } from '../src/memory/InMemoryStore';
import type { MemoryWriteRequest } from '../src/types/memory';

function makeWrite(overrides?: Partial<MemoryWriteRequest>): MemoryWriteRequest {
  return {
    entry: {
      tier: 'working',
      scope: 'run',
      content: 'test content',
      confidence: 1.0,
      ttlMs: 0,
      tags: [],
      provenance: 'agent',
      ...overrides?.entry,
    },
    overwriteStrategy: overrides?.overwriteStrategy ?? 'replace',
    ...overrides,
  } as MemoryWriteRequest;
}

// ── InMemoryStore ──

describe('InMemoryStore', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('writes and reads entries', async () => {
    const req = makeWrite();
    const written = await store.write(req);

    const read = await store.read(written.id);
    expect(read).toBeDefined();
    expect(read!.content).toBe('test content');
  });

  it('returns null for non-existent entry', async () => {
    expect(await store.read('nonexistent')).toBeNull();
  });

  it('deletes entries', async () => {
    const req = makeWrite();
    const written = await store.write(req);

    expect(await store.delete(written.id)).toBe(true);
    expect(await store.read(written.id)).toBeNull();
  });

  it('returns false when deleting non-existent entry', async () => {
    expect(await store.delete('nonexistent')).toBe(false);
  });

  it('searches by tier', async () => {
    await store.write(makeWrite({ entry: { tier: 'working', scope: 'run', content: 'w', confidence: 1, ttlMs: 0, tags: [], provenance: 'agent' } }));
    await store.write(makeWrite({ entry: { tier: 'episodic', scope: 'run', content: 'e', confidence: 1, ttlMs: 0, tags: [], provenance: 'agent' } }));

    const working = await store.search({ tier: 'working' });
    expect(working.length).toBeGreaterThanOrEqual(1);
    expect(working.every((e) => e.tier === 'working')).toBe(true);
  });

  it('searches by scope', async () => {
    await store.write(makeWrite({ entry: { tier: 'working', scope: 'run', content: 'r', confidence: 1, ttlMs: 0, tags: [], provenance: 'agent' } }));
    await store.write(makeWrite({ entry: { tier: 'working', scope: 'agent', content: 'a', confidence: 1, ttlMs: 0, tags: [], provenance: 'agent' } }));

    const runScoped = await store.search({ scope: 'run' });
    expect(runScoped.every((e) => e.scope === 'run')).toBe(true);
  });

  it('respects search limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.write(makeWrite());
    }

    const results = await store.search({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('searches workspace state references by kind and resource', async () => {
    await store.write(makeWrite({
      entry: {
        tier: 'semantic',
        kind: 'workspace_state',
        scope: 'agent',
        content: 'Deployment revision is ready',
        confidence: 0.95,
        ttlMs: 0,
        tags: ['deployment'],
        provenance: 'control_plane',
        stateRef: {
          resourceType: 'deployment',
          resourceId: 'deploy_123',
          authority: 'control_plane',
          version: 'rev_7',
        },
      },
    }));
    await store.write(makeWrite({
      entry: {
        tier: 'semantic',
        kind: 'workspace_state',
        scope: 'agent',
        content: 'Incident is open',
        confidence: 0.9,
        ttlMs: 0,
        tags: ['incident'],
        provenance: 'control_plane',
        stateRef: {
          resourceType: 'incident',
          resourceId: 'inc_456',
          authority: 'control_plane',
        },
      },
    }));

    const results = await store.search({
      kind: 'workspace_state',
      resourceType: 'deployment',
      resourceId: 'deploy_123',
    });

    expect(results).toHaveLength(1);
    expect(results[0].stateRef?.resourceType).toBe('deployment');
    expect(results[0].stateRef?.resourceId).toBe('deploy_123');
  });
});

// ── MemoryManager ──

describe('MemoryManager', () => {
  let manager: MemoryManager;

  beforeEach(() => {
    manager = new MemoryManager();
  });

  it('writes and reads a memory entry', async () => {
    const written = await manager.write(makeWrite());
    const read = await manager.read(written.id);

    expect(read).toBeDefined();
    expect(read!.id).toBe(written.id);
  });

  it('throws when writing to disabled tier', async () => {
    const mgr = new MemoryManager({
      episodic: { enabled: false },
    });

    await expect(
      mgr.write(makeWrite({ entry: { tier: 'episodic', scope: 'run', content: 'x', confidence: 1, ttlMs: 0, tags: [], provenance: 'agent' } })),
    ).rejects.toThrow("not enabled");
  });

  it('searches memory', async () => {
    await manager.write(makeWrite());
    const results = await manager.search({});

    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('deletes memory', async () => {
    const written = await manager.write(makeWrite());
    expect(await manager.delete(written.id)).toBe(true);
    expect(await manager.read(written.id)).toBeNull();
  });

  it('getWorkingMemory returns working-tier entries', async () => {
    await manager.write(makeWrite({ entry: { tier: 'working', scope: 'run', content: 'w', confidence: 1, ttlMs: 0, tags: [], provenance: 'agent' } }));
    const entries = await manager.getWorkingMemory('run_1');

    expect(entries.length).toBeGreaterThanOrEqual(0);
  });

  it('returns workspace state entries via helper', async () => {
    await manager.write(makeWrite({
      entry: {
        tier: 'semantic',
        kind: 'workspace_state',
        scope: 'agent',
        content: 'Task queue depth is elevated',
        confidence: 0.92,
        ttlMs: 0,
        tags: ['task'],
        provenance: 'control_plane',
        stateRef: {
          resourceType: 'task',
          resourceId: 'task_42',
          authority: 'control_plane',
        },
      },
    }));

    const entries = await manager.getWorkspaceState({ resourceType: 'task' });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('workspace_state');
  });

  it('returns derived memory entries via helper', async () => {
    await manager.write(makeWrite({
      entry: {
        tier: 'episodic',
        kind: 'derived_memory',
        scope: 'agent',
        content: 'Daily summary of failed payouts',
        confidence: 0.88,
        ttlMs: 0,
        tags: ['summary'],
        provenance: 'agent',
        derivation: {
          strategy: 'summary',
          sourceResourceIds: ['incident_1', 'payout_7'],
        },
      },
    }));

    const entries = await manager.getDerivedMemory();
    expect(entries).toHaveLength(1);
    expect(entries[0].derivation?.strategy).toBe('summary');
  });
});
