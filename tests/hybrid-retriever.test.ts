import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '../src/memory/InMemoryStore';
import { InMemorySemanticGraph } from '../src/memory/SemanticMemoryGraph';
import { HybridRetriever, type RetrievalMode, type ScoredMemory } from '../src/memory/HybridRetriever';
import type { MemoryEntry } from '../src/types/memory';

async function seed(store: InMemoryStore, entries: Array<Partial<MemoryEntry> & { content: string }>) {
  const ids: string[] = [];
  for (const e of entries) {
    const written = await store.write({
      entry: {
        tier: e.tier ?? 'semantic',
        content: e.content,
        provenance: e.provenance ?? 'agent',
        confidence: e.confidence ?? 0.9,
        scope: e.scope ?? 'agent',
        ttlMs: e.ttlMs ?? 0,
        tags: e.tags ?? [],
        embedding: e.embedding,
      },
      overwriteStrategy: 'skip',
    });
    ids.push(written.id);
  }
  return ids;
}

describe('HybridRetriever', () => {
  it('ranks lexical matches above unrelated entries', async () => {
    const store = new InMemoryStore();
    await seed(store, [
      { content: 'the quick brown fox jumps over the lazy dog' },
      { content: 'completely unrelated content about ocean tides' },
      { content: 'brown fox sightings on the trail' },
    ]);
    const retriever = new HybridRetriever(store);
    const results = await retriever.retrieve({ text: 'brown fox' }, { modes: ['lexical'] });
    expect(results.length).toBe(3);
    expect(results[0].entry.content).toContain('brown fox');
    expect(results[results.length - 1].entry.content).toContain('ocean');
  });

  it('temporal mode favours recently accessed entries', async () => {
    const store = new InMemoryStore();
    const ids = await seed(store, [
      { content: 'old note' },
      { content: 'fresh note' },
    ]);
    const internal = (store as unknown as { entries: Map<string, MemoryEntry> }).entries;
    const now = Date.now();
    const old = internal.get(ids[0]) as MemoryEntry;
    old.lastAccessedAt = now - 30 * 24 * 60 * 60 * 1000; // 30 days
    const fresh = internal.get(ids[1]) as MemoryEntry;
    fresh.lastAccessedAt = now;

    const retriever = new HybridRetriever(store);
    const results = await retriever.retrieve(
      { text: 'note' },
      { modes: ['temporal'], now },
    );
    expect(results[0].entry.content).toBe('fresh note');
  });

  it('vector mode uses cosine similarity when embeddings are supplied', async () => {
    const store = new InMemoryStore();
    await seed(store, [
      { content: 'cats', embedding: [1, 0, 0] },
      { content: 'dogs', embedding: [0, 1, 0] },
      { content: 'parrots', embedding: [0, 0, 1] },
    ]);
    const retriever = new HybridRetriever(store);
    const results = await retriever.retrieve(
      { text: 'q' },
      {
        modes: ['vector'],
        embed: () => [0.9, 0.1, 0],
      },
    );
    expect(results[0].entry.content).toBe('cats');
  });

  it('graph mode expands from seeds and ranks nearby nodes higher', async () => {
    const store = new InMemoryStore();
    const ids = await seed(store, [
      { content: 'root' },
      { content: 'one hop' },
      { content: 'two hops' },
      { content: 'far away' },
    ]);
    const graph = new InMemorySemanticGraph();
    await graph.addEdge({ fromId: ids[0], toId: ids[1], kind: 'relatesTo', weight: 1 });
    await graph.addEdge({ fromId: ids[1], toId: ids[2], kind: 'relatesTo', weight: 1 });

    const retriever = new HybridRetriever(store);
    const results = await retriever.retrieve(
      { text: 'ignored' },
      {
        modes: ['graph'],
        graph,
        seedIds: [ids[0]],
        graphMaxHops: 2,
        applyConfidence: false,
      },
    );
    // root and one-hop should beat two-hop, which beats unreachable.
    const byContent = new Map(results.map((r) => [r.entry.content, r.score]));
    expect(byContent.get('root')).toBeGreaterThan(byContent.get('two hops') ?? 0);
    expect(byContent.get('one hop')).toBeGreaterThan(byContent.get('two hops') ?? 0);
    expect(byContent.get('far away') ?? 0).toBe(0);
  });

  it('hybrid mode blends lexical + temporal with normalised weights', async () => {
    const store = new InMemoryStore();
    const ids = await seed(store, [
      { content: 'stale match for brown fox' },
      { content: 'fresh unrelated entry about clouds' },
    ]);
    const retriever = new HybridRetriever(store);
    const modes: RetrievalMode[] = ['lexical', 'temporal'];

    const internal = (store as unknown as { entries: Map<string, MemoryEntry> }).entries;
    const now = Date.now();
    const backdate = () => {
      (internal.get(ids[0]) as MemoryEntry).lastAccessedAt = now - 365 * 24 * 60 * 60 * 1000;
      (internal.get(ids[1]) as MemoryEntry).lastAccessedAt = now;
    };

    backdate();
    const lexicalHeavy = await retriever.retrieve(
      { text: 'brown fox' },
      { modes, weights: { lexical: 9, temporal: 1 }, now },
    );
    backdate();
    const temporalHeavy = await retriever.retrieve(
      { text: 'brown fox' },
      { modes, weights: { lexical: 1, temporal: 9 }, now },
    );
    expect(lexicalHeavy[0].entry.content).toContain('brown fox');
    expect(temporalHeavy[0].entry.content).toContain('clouds');
  });

  it('respects the limit parameter', async () => {
    const store = new InMemoryStore();
    await seed(store, [
      { content: 'alpha' },
      { content: 'beta' },
      { content: 'gamma' },
    ]);
    const retriever = new HybridRetriever(store);
    const results = await retriever.retrieve(
      { text: 'a' },
      { modes: ['lexical'], limit: 2 },
    );
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('multiplies score by confidence when applyConfidence is enabled', async () => {
    const store = new InMemoryStore();
    await seed(store, [
      { content: 'same words here', confidence: 1.0 },
      { content: 'same words here too', confidence: 0.1 },
    ]);
    const retriever = new HybridRetriever(store);
    const results = await retriever.retrieve(
      { text: 'same words' },
      { modes: ['lexical'], applyConfidence: true },
    );
    expect(results[0].entry.confidence).toBe(1);
  });

  it('applies provenance weights to boost trusted sources', async () => {
    const store = new InMemoryStore();
    await seed(store, [
      { content: 'shared topic', provenance: 'tool' },
      { content: 'shared topic from user', provenance: 'user' },
    ]);
    const retriever = new HybridRetriever(store);
    const results = await retriever.retrieve(
      { text: 'shared topic' },
      {
        modes: ['lexical'],
        provenanceWeights: { user: 1.5, tool: 0.5 },
      },
    );
    expect(results[0].entry.provenance).toBe('user');
    expect(results[0].provenanceMultiplier).toBe(1.5);
  });

  it('penalises derived entries lacking source references', async () => {
    const store = new InMemoryStore();
    await seed(store, [
      { content: 'note A' },
      { content: 'note B' },
    ]);
    // mutate one entry to be a derived memory with no sources
    const internal = (store as unknown as { entries: Map<string, MemoryEntry> }).entries;
    const first = Array.from(internal.values())[0];
    first.derivation = { strategy: 'summary' };

    const retriever = new HybridRetriever(store);
    const results = await retriever.retrieve(
      { text: 'note' },
      {
        modes: ['lexical'],
        unverifiedDerivationPenalty: 0.5,
        applyConfidence: false,
      },
    );
    const penalised = results.find((r) => r.entry.id === first.id);
    const other = results.find((r) => r.entry.id !== first.id);
    expect(penalised && other).toBeTruthy();
    expect((penalised as ScoredMemory).score).toBeLessThan((other as ScoredMemory).score);
  });

  it('exposes provenanceMultiplier and confidenceFactor on every result', async () => {
    const store = new InMemoryStore();
    await seed(store, [{ content: 'hello world', confidence: 0.8, provenance: 'agent' }]);
    const retriever = new HybridRetriever(store);
    const results = await retriever.retrieve(
      { text: 'hello' },
      { modes: ['lexical'], provenanceWeights: { agent: 1.2 } },
    );
    expect(results[0].provenanceMultiplier).toBe(1.2);
    expect(results[0].confidenceFactor).toBe(0.8);
  });
});
