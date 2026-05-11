/**
 * Tests for long-horizon memory primitives.
 */
import { describe, it, expect } from 'vitest';
import {
  InMemoryEpisodicStore,
  InMemoryEntityRegistry,
  InMemoryTemporalGraph,
  HighlightConcatenatingSummariser,
  createInMemoryLongHorizonMemory,
} from '../src';

describe('InMemoryEntityRegistry', () => {
  it('resolves aliases case-insensitively', async () => {
    const reg = new InMemoryEntityRegistry();
    await reg.upsert({
      id: 'user_1',
      kind: 'person',
      name: 'Alice Liddell',
      aliases: ['the user', 'alice@example.com'],
    });
    const r1 = await reg.resolve('THE USER');
    const r2 = await reg.resolve('alice@example.com');
    expect(r1?.id).toBe('user_1');
    expect(r2?.id).toBe('user_1');
  });

  it('merges upserts with overlapping aliases', async () => {
    const reg = new InMemoryEntityRegistry();
    await reg.upsert({ id: 'a', kind: 'person', name: 'Alice', aliases: ['alice@x'] });
    const merged = await reg.upsert({
      id: 'should_be_ignored',
      kind: 'person',
      name: 'Alice',
      aliases: ['alice@x', 'liddell'],
    });
    expect(merged.id).toBe('a');
    expect(merged.aliases).toContain('liddell');
  });

  it('rejects alias collisions on addAlias', async () => {
    const reg = new InMemoryEntityRegistry();
    await reg.upsert({ id: 'a', kind: 'person', name: 'A', aliases: [] });
    await reg.upsert({ id: 'b', kind: 'person', name: 'B', aliases: [] });
    await reg.addAlias('a', 'shared');
    await expect(reg.addAlias('b', 'shared')).rejects.toThrow();
  });
});

describe('InMemoryTemporalGraph', () => {
  it('respects validAt windows', async () => {
    const g = new InMemoryTemporalGraph();
    await g.add({
      id: 'e1',
      fromId: 'alice',
      toId: 'project_x',
      relation: 'owns',
      validFrom: 100,
      validTo: 200,
    });
    await g.add({
      id: 'e2',
      fromId: 'bob',
      toId: 'project_x',
      relation: 'owns',
      validFrom: 200,
    });
    expect((await g.query({ validAt: 150 })).map((e) => e.id)).toEqual(['e1']);
    expect((await g.query({ validAt: 250 })).map((e) => e.id)).toEqual(['e2']);
    expect((await g.query({ validAt: 200 })).map((e) => e.id)).toEqual(['e2']);
  });

  it('close() sets validTo idempotently', async () => {
    const g = new InMemoryTemporalGraph();
    await g.add({ id: 'e1', fromId: 'a', toId: 'b', relation: 'r', validFrom: 1 });
    const closed = await g.close('e1', 50);
    expect(closed.validTo).toBe(50);
    const stillClosed = await g.close('e1', 999);
    expect(stillClosed.validTo).toBe(50);
  });
});

describe('InMemoryEpisodicStore', () => {
  it('opens, closes, and queries by entity', async () => {
    const store = new InMemoryEpisodicStore();
    await store.open({ id: 'r1', label: 'run 1', kind: 'run', entityIds: ['user_1'] });
    await store.open({ id: 'r2', label: 'run 2', kind: 'run', entityIds: ['user_2'] });
    await store.close('r1');
    const byUser = await store.query({ entityId: 'user_1' });
    expect(byUser.map((e) => e.id)).toEqual(['r1']);
  });

  it('compresses closed uncompressed episodes', async () => {
    const store = new InMemoryEpisodicStore();
    await store.open({ id: 'r1', label: 'run 1', kind: 'run', highlights: ['h1'] });
    await store.close('r1');
    await store.open({ id: 'r2', label: 'run 2', kind: 'run' });
    // r2 still open, should not be compressed.

    const archive: Array<{ id: string; lines: string[] }> = [];
    const touched = await store.compress({
      summariser: new HighlightConcatenatingSummariser(),
      fetchRaw: async (id) => [`raw line A for ${id}`, `raw line B for ${id}`],
      archiveRaw: async (id, raw) => {
        archive.push({ id, lines: raw });
      },
    });
    expect(touched).toEqual(['r1']);
    expect(archive).toHaveLength(1);
    expect(archive[0].id).toBe('r1');

    const stored = await store.get('r1');
    expect(stored?.summary).toContain('Episode "run 1"');
    expect(stored?.summary).toContain('h1');

    // Second compress pass is a no-op.
    const touched2 = await store.compress({
      summariser: new HighlightConcatenatingSummariser(),
      fetchRaw: async () => [],
    });
    expect(touched2).toEqual([]);
  });
});

describe('createInMemoryLongHorizonMemory', () => {
  it('bundles all three stores', () => {
    const lhm = createInMemoryLongHorizonMemory();
    expect(lhm.episodes).toBeDefined();
    expect(lhm.entities).toBeDefined();
    expect(lhm.temporal).toBeDefined();
  });
});
