import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../src/memory/InMemoryStore';
import { InMemorySemanticGraph } from '../src/memory/SemanticMemoryGraph';
import { MemoryLifecycle } from '../src/memory/MemoryLifecycle';
import type { MemoryEntry } from '../src/types/memory';

type WriteOpts = Partial<Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt'>>;

async function seed(store: InMemoryStore, opts: WriteOpts): Promise<MemoryEntry> {
  return store.write({
    overwriteStrategy: 'append',
    entry: {
      tier: opts.tier ?? 'episodic',
      content: opts.content ?? 'note',
      provenance: opts.provenance ?? 'agent',
      confidence: opts.confidence ?? 0.5,
      scope: opts.scope ?? 'agent',
      ttlMs: opts.ttlMs ?? 0,
      tags: opts.tags ?? [],
    },
  });
}

describe('MemoryLifecycle.dedupe', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('collapses exact-content duplicates within the same tier and merges tags', async () => {
    const a = await seed(store, { content: 'sky is blue', confidence: 0.6, tags: ['fact'] });
    const b = await seed(store, { content: 'sky is blue', confidence: 0.9, tags: ['stable'] });
    const lifecycle = new MemoryLifecycle({ store });

    const res = await lifecycle.dedupe();
    expect(res.removed).toBe(1);
    expect(res.merged).toBe(1);

    expect(await store.read(b.id)).not.toBeNull(); // higher-confidence survives
    expect(await store.read(a.id)).toBeNull();
    const survivor = (await store.read(b.id))!;
    expect(survivor.tags.sort()).toEqual(['fact', 'stable']);
    expect(survivor.confidence).toBeGreaterThan(0.9);
  });

  it('does not merge entries across different tiers', async () => {
    await seed(store, { content: 'same', tier: 'episodic' });
    await seed(store, { content: 'same', tier: 'semantic' });
    const res = await new MemoryLifecycle({ store }).dedupe();
    expect(res.removed).toBe(0);
  });

  it('merges via embedding similarity when an embedder is supplied', async () => {
    await seed(store, { content: 'A', confidence: 0.5 });
    await seed(store, { content: 'B', confidence: 0.8 });
    await seed(store, { content: 'C', confidence: 0.3 });
    const embed = (text: string): number[] => {
      // A and B are "near-duplicates"; C is unrelated.
      if (text === 'A' || text === 'B') return [1, 0.99, 0];
      return [0, 0, 1];
    };
    const res = await new MemoryLifecycle({
      store,
      embed,
      dedupe: { similarityThreshold: 0.95 },
    }).dedupe();
    expect(res.removed).toBe(1);
    const left = await store.search({ limit: 100 });
    expect(left).toHaveLength(2);
  });
});

describe('MemoryLifecycle.promote', () => {
  it('promotes high-confidence, aged episodic entries to semantic', async () => {
    const store = new InMemoryStore();
    const young = await seed(store, { tier: 'episodic', confidence: 0.9 });
    const old = await seed(store, { tier: 'episodic', confidence: 0.9 });
    // Force `old` to look ancient by rewriting its createdAt.
    const internal = (store as unknown as { entries: Map<string, MemoryEntry> }).entries;
    internal.get(old.id)!.createdAt = Date.now() - 60_000_000;

    const res = await new MemoryLifecycle({
      store,
      promote: { minConfidence: 0.8, minAgeMs: 1000 },
    }).promote();
    expect(res.promoted).toBe(1);
    expect((await store.read(old.id))!.tier).toBe('semantic');
    expect((await store.read(young.id))!.tier).toBe('episodic');
  });

  it('ignores entries below the confidence floor', async () => {
    const store = new InMemoryStore();
    const e = await seed(store, { tier: 'episodic', confidence: 0.2 });
    const internal = (store as unknown as { entries: Map<string, MemoryEntry> }).entries;
    internal.get(e.id)!.createdAt = Date.now() - 60_000_000;
    const res = await new MemoryLifecycle({
      store,
      promote: { minConfidence: 0.8, minAgeMs: 1000 },
    }).promote();
    expect(res.promoted).toBe(0);
  });
});

describe('MemoryLifecycle.decay', () => {
  it('applies exponential decay and removes entries below the floor', async () => {
    const store = new InMemoryStore();
    const fresh = await seed(store, { confidence: 0.9 });
    const stale = await seed(store, { confidence: 0.9 });
    const internal = (store as unknown as { entries: Map<string, MemoryEntry> }).entries;
    // Stale was last accessed 10 half-lives ago → factor ≈ 0.001 → below floor.
    internal.get(stale.id)!.lastAccessedAt = Date.now() - 10_000;
    // Fresh was last accessed 1 half-life ago → factor 0.5 → confidence 0.45.
    internal.get(fresh.id)!.lastAccessedAt = Date.now() - 1_000;

    const res = await new MemoryLifecycle({
      store,
      decay: { halfLifeMs: 1_000, floor: 0.05 },
    }).decay();
    expect(res.removed).toBe(1);
    expect(res.decayed).toBe(1);
    expect(await store.read(stale.id)).toBeNull();
    const survivor = (await store.read(fresh.id))!;
    expect(survivor.confidence).toBeLessThan(0.9);
    expect(survivor.confidence).toBeGreaterThan(0.05);
  });

  it('never decays procedural memory', async () => {
    const store = new InMemoryStore();
    const skill = await seed(store, { tier: 'procedural', confidence: 0.9 });
    const internal = (store as unknown as { entries: Map<string, MemoryEntry> }).entries;
    internal.get(skill.id)!.lastAccessedAt = Date.now() - 10_000;
    const res = await new MemoryLifecycle({
      store,
      decay: { halfLifeMs: 1_000, floor: 0.05 },
    }).decay();
    expect(res.removed).toBe(0);
    expect(res.decayed).toBe(0);
    expect((await store.read(skill.id))!.confidence).toBe(0.9);
  });
});

describe('MemoryLifecycle.reconcile', () => {
  it('reports contradicts edges as conflicts', async () => {
    const store = new InMemoryStore();
    const graph = new InMemorySemanticGraph();
    await graph.addEdge({ fromId: 'x', toId: 'y', kind: 'contradicts' });
    await graph.addEdge({ fromId: 'x', toId: 'z', kind: 'relatesTo' });
    const res = await new MemoryLifecycle({ store, graph }).reconcile();
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]!.a).toBe('x');
    expect(res.conflicts[0]!.b).toBe('y');
  });

  it('returns an empty list when no graph is configured', async () => {
    const res = await new MemoryLifecycle({ store: new InMemoryStore() }).reconcile();
    expect(res.conflicts).toEqual([]);
  });
});

describe('MemoryLifecycle.run', () => {
  it('runs all phases and returns a unified report', async () => {
    const store = new InMemoryStore();
    const graph = new InMemorySemanticGraph();
    await seed(store, { content: 'dup', confidence: 0.5 });
    await seed(store, { content: 'dup', confidence: 0.9 });
    const report = await new MemoryLifecycle({ store, graph }).run();
    expect(report.dedupe.removed).toBe(1);
    expect(report.promote.promoted).toBeGreaterThanOrEqual(0);
    expect(report.decay).toBeDefined();
    expect(report.reconcile.conflicts).toEqual([]);
  });
});
