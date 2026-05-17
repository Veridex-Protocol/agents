import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemorySemanticGraph,
  type SemanticMemoryGraph,
} from '../src/memory/SemanticMemoryGraph';

describe('InMemorySemanticGraph', () => {
  let g: SemanticMemoryGraph;
  beforeEach(() => {
    g = new InMemorySemanticGraph();
  });

  it('adds and retrieves a typed edge', async () => {
    const e = await g.addEdge({ fromId: 'a', toId: 'b', kind: 'relatesTo' });
    expect(e.id).toMatch(/^edge_/);
    expect(e.weight).toBe(1);
    const got = await g.getEdge(e.id);
    expect(got?.kind).toBe('relatesTo');
  });

  it('rejects self-edges and out-of-range weights', async () => {
    await expect(g.addEdge({ fromId: 'a', toId: 'a', kind: 'relatesTo' })).rejects.toThrow();
    await expect(
      g.addEdge({ fromId: 'a', toId: 'b', kind: 'relatesTo', weight: 1.5 }),
    ).rejects.toThrow();
    await expect(
      g.addEdge({ fromId: 'a', toId: 'b', kind: 'relatesTo', weight: -0.1 }),
    ).rejects.toThrow();
  });

  it('queries by fromId, toId, and kinds', async () => {
    await g.addEdge({ fromId: 'a', toId: 'b', kind: 'relatesTo' });
    await g.addEdge({ fromId: 'a', toId: 'c', kind: 'derivedFrom' });
    await g.addEdge({ fromId: 'b', toId: 'c', kind: 'contradicts' });

    const fromA = await g.query({ fromId: 'a' });
    expect(fromA).toHaveLength(2);

    const toC = await g.query({ toId: 'c' });
    expect(toC).toHaveLength(2);

    const onlyDerived = await g.query({ kinds: ['derivedFrom'] });
    expect(onlyDerived).toHaveLength(1);
    expect(onlyDerived[0]!.fromId).toBe('a');
    expect(onlyDerived[0]!.toId).toBe('c');
  });

  it('filters by minWeight and respects limit', async () => {
    await g.addEdge({ fromId: 'a', toId: 'b', kind: 'relatesTo', weight: 0.3 });
    await g.addEdge({ fromId: 'a', toId: 'c', kind: 'relatesTo', weight: 0.9 });
    await g.addEdge({ fromId: 'a', toId: 'd', kind: 'relatesTo', weight: 0.5 });

    const strong = await g.query({ fromId: 'a', minWeight: 0.5 });
    expect(strong).toHaveLength(2);

    const capped = await g.query({ fromId: 'a', limit: 1 });
    expect(capped).toHaveLength(1);
  });

  it('returns undirected neighbors and filters by kind', async () => {
    await g.addEdge({ fromId: 'a', toId: 'b', kind: 'relatesTo' });
    await g.addEdge({ fromId: 'c', toId: 'a', kind: 'derivedFrom' });
    await g.addEdge({ fromId: 'a', toId: 'd', kind: 'contradicts' });

    const all = (await g.neighbors('a')).sort();
    expect(all).toEqual(['b', 'c', 'd']);

    const only = await g.neighbors('a', ['derivedFrom']);
    expect(only).toEqual(['c']);
  });

  it('removes a single edge', async () => {
    const e = await g.addEdge({ fromId: 'a', toId: 'b', kind: 'relatesTo' });
    expect(await g.removeEdge(e.id)).toBe(true);
    expect(await g.getEdge(e.id)).toBeNull();
    expect(await g.size()).toBe(0);
    expect(await g.removeEdge(e.id)).toBe(false);
  });

  it('removeNode drops all touching edges and returns count', async () => {
    await g.addEdge({ fromId: 'a', toId: 'b', kind: 'relatesTo' });
    await g.addEdge({ fromId: 'c', toId: 'a', kind: 'derivedFrom' });
    await g.addEdge({ fromId: 'a', toId: 'd', kind: 'contradicts' });
    await g.addEdge({ fromId: 'b', toId: 'c', kind: 'relatesTo' });

    const removed = await g.removeNode('a');
    expect(removed).toBe(3);
    expect(await g.neighbors('a')).toEqual([]);
    expect(await g.size()).toBe(1);
  });

  it('clear resets everything', async () => {
    await g.addEdge({ fromId: 'a', toId: 'b', kind: 'relatesTo' });
    await g.addEdge({ fromId: 'b', toId: 'c', kind: 'relatesTo' });
    await g.clear();
    expect(await g.size()).toBe(0);
    expect(await g.neighbors('a')).toEqual([]);
  });
});
