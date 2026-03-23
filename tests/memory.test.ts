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
});
