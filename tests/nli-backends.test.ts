/**
 * Tests for the pluggable NLI backends.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  KeywordOverlapNLIBackend,
  EmbeddingSimilarityNLIBackend,
  LLMJudgeNLIBackend,
  CompositeNLIBackend,
} from '../src/intent/NLIBackends';

describe('KeywordOverlapNLIBackend', () => {
  it('returns 0 for completely unrelated text', async () => {
    const b = new KeywordOverlapNLIBackend();
    const s = await b.score('transfer tokens between wallets', 'bake a chocolate cake');
    expect(s).toBeLessThanOrEqual(0.1);
  });

  it('returns high similarity for near-identical intent', async () => {
    const b = new KeywordOverlapNLIBackend();
    const s = await b.score(
      'send payment to supplier wallet',
      'send payment to supplier wallet',
    );
    expect(s).toBe(1);
  });

  it('discards stopwords and short tokens', async () => {
    const b = new KeywordOverlapNLIBackend();
    const s = await b.score('the a if is', 'the a if is');
    expect(s).toBe(0); // nothing left after stopword removal
  });
});

describe('EmbeddingSimilarityNLIBackend', () => {
  it('computes cosine similarity and normalizes to [0,1]', async () => {
    const embed = vi.fn(async (t: string) => {
      if (t === 'A') return [1, 0];
      if (t === 'B') return [0, 1];
      return [1, 0];
    });
    const b = new EmbeddingSimilarityNLIBackend({ embed });
    // A vs A → cosine 1 → normalized 1
    expect(await b.score('A', 'A')).toBeCloseTo(1);
    // A vs B → cosine 0 → normalized 0.5
    expect(await b.score('A', 'B')).toBeCloseTo(0.5);
  });

  it('caches embeddings (does not re-embed the same text across calls)', async () => {
    const embed = vi.fn(async (_t: string) => [1, 0, 0]);
    const b = new EmbeddingSimilarityNLIBackend({ embed });
    // Different strings within one call so Promise.all doesn't race on the same key.
    await b.score('alpha', 'beta');
    // Reuse both — should be served from cache.
    await b.score('alpha', 'beta');
    await b.score('alpha', 'beta');
    expect(embed).toHaveBeenCalledTimes(2); // one per unique input, total
  });

  it('handles zero-magnitude vectors safely', async () => {
    const embed = vi.fn(async () => [0, 0, 0]);
    const b = new EmbeddingSimilarityNLIBackend({ embed });
    const s = await b.score('x', 'y');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe('LLMJudgeNLIBackend', () => {
  it('parses a direct JSON response', async () => {
    const chat = vi.fn(async () => '{"score": 0.82, "reasoning": "aligned"}');
    const j = new LLMJudgeNLIBackend({ chat });
    expect(await j.score('send tokens', 'transfer USDC')).toBeCloseTo(0.82);
  });

  it('parses a response wrapped in fenced code block', async () => {
    const chat = vi.fn(async () => '```json\n{"score": 0.1}\n```');
    const j = new LLMJudgeNLIBackend({ chat });
    expect(await j.score('x', 'y')).toBeCloseTo(0.1);
  });

  it('retries once on malformed output then fails closed with 0', async () => {
    const chat = vi.fn(async () => 'I cannot comply with that request.');
    const j = new LLMJudgeNLIBackend({ chat });
    const s = await j.score('x', 'y');
    expect(s).toBe(0);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('clamps out-of-range scores via zod validation (fails closed)', async () => {
    const chat = vi.fn(async () => '{"score": 5}');
    const j = new LLMJudgeNLIBackend({ chat });
    expect(await j.score('x', 'y')).toBe(0);
  });
});

describe('CompositeNLIBackend', () => {
  const highBackend = { score: async () => 0.9 };
  const lowBackend = { score: async () => 0.1 };
  const midBackend = { score: async () => 0.5 };

  it("'max' strategy returns the highest score", async () => {
    const c = new CompositeNLIBackend({
      backends: [highBackend, lowBackend, midBackend],
      strategy: 'max',
    });
    expect(await c.score('x', 'y')).toBeCloseTo(0.9);
  });

  it("'min' strategy returns the lowest score", async () => {
    const c = new CompositeNLIBackend({
      backends: [highBackend, lowBackend, midBackend],
      strategy: 'min',
    });
    expect(await c.score('x', 'y')).toBeCloseTo(0.1);
  });

  it("'avg' strategy returns the mean", async () => {
    const c = new CompositeNLIBackend({
      backends: [highBackend, lowBackend, midBackend],
      strategy: 'avg',
    });
    expect(await c.score('x', 'y')).toBeCloseTo(0.5);
  });

  it('failing backend counts as 0, does not throw', async () => {
    const throwing = { score: async () => { throw new Error('down'); } };
    const c = new CompositeNLIBackend({
      backends: [throwing, highBackend],
      strategy: 'avg',
    });
    // Expected avg of 0 and 0.9 = 0.45
    expect(await c.score('x', 'y')).toBeCloseTo(0.45);
  });

  it('rejects empty backend list', () => {
    expect(() => new CompositeNLIBackend({ backends: [] })).toThrow();
  });
});
