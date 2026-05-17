import { describe, it, expect } from 'vitest';
import {
  LRUEncodingTracker,
  defaultChunker,
} from '../src/context/EncodingState';
import {
  HomeostaticContextEngine,
} from '../src/context/HomeostaticContextEngine';
import { LinearFidelityModel } from '../src/context/FidelityModel';
import type { ContextSectionInput } from '../src/types/context';

describe('LRUEncodingTracker', () => {
  it('treats novel content as cold and re-injected content as warm', () => {
    const t = new LRUEncodingTracker({ threadId: 'thread-1' });
    const text = 'Para A.\n\nPara B.';
    const first = t.classify(text);
    expect(first.warmTokens).toBe(0);
    expect(first.coldTokens).toBeGreaterThan(0);
    expect(first.warmFraction).toBe(0);

    t.record(text);
    const second = t.classify(text);
    expect(second.coldTokens).toBe(0);
    expect(second.warmTokens).toBe(first.coldTokens);
    expect(second.warmFraction).toBeCloseTo(1, 10);
  });

  it('classify is pure (does not change state)', () => {
    const t = new LRUEncodingTracker({ threadId: 'thread-2' });
    t.classify('only classify');
    expect(t.snapshot().size).toBe(0);
  });

  it('honours explicit chunkTokens overrides', () => {
    const t = new LRUEncodingTracker({ threadId: 'thread-3' });
    const text = 'AAA.\n\nBBB.';
    t.record(text, { chunkTokens: [10, 20] });
    const snap = t.snapshot();
    expect(snap.totalTokens).toBe(30);
  });

  it('partial overlap reports correct warm fraction', () => {
    const t = new LRUEncodingTracker({ threadId: 'thread-4' });
    t.record('Shared.', { chunkTokens: [4] });
    const c = t.classify('Shared.\n\nNovel content here.', { chunkTokens: [4, 6] });
    expect(c.warmTokens).toBe(4);
    expect(c.coldTokens).toBe(6);
    expect(c.warmFraction).toBeCloseTo(4 / 10, 10);
  });

  it('serialize / deserialize round-trips chunk state', () => {
    const a = new LRUEncodingTracker({ threadId: 'tx' });
    a.record('chunk one.\n\nchunk two.');
    const payload = a.serialize();
    const b = new LRUEncodingTracker({ threadId: 'tx' });
    b.deserialize(payload);
    const c = b.classify('chunk one.\n\nchunk two.');
    expect(c.warmFraction).toBeCloseTo(1, 10);
  });

  it('LRU eviction trims oldest chunks beyond cap', () => {
    const t = new LRUEncodingTracker({ threadId: 'cap', maxChunks: 2 });
    t.record('one.');
    t.record('two.');
    t.record('three.'); // evicts "one."
    const cold = t.classify('one.');
    expect(cold.warmFraction).toBe(0);
    const warm = t.classify('three.');
    expect(warm.warmFraction).toBeCloseTo(1, 10);
  });

  it('defaultChunker splits on blank lines and normalises whitespace', () => {
    const chunks = defaultChunker('  hello\n\n\nworld  ');
    expect(chunks).toEqual(['hello', 'world']);
  });
});

describe('HomeostaticContextEngine + EncodingTracker', () => {
  function makeSection(id: string, content: string, priority = 50): ContextSectionInput {
    return { id, source: 'memory', content, priority };
  }

  it('warm content reduces effective prompt tokens vs cold content', () => {
    // Use a hot fidelity model so the effect is visible.
    const model = new LinearFidelityModel(2.0);
    const tracker = new LRUEncodingTracker({ threadId: 't' });
    const engine = new HomeostaticContextEngine({
      fidelityModel: model,
      fidelityTarget: 0.5,
      encoding: tracker,
      warmDiscount: 0.0, // warm tokens cost zero
    });

    const sections = [
      makeSection('s1', 'paragraph one.\n\nparagraph two.'),
    ];
    const first = engine.compile({ maxTokens: 100_000, sections });
    expect(first.fidelityReport.warmTokens).toBe(0);
    expect(first.fidelityReport.coldTokens).toBeGreaterThan(0);
    expect(first.fidelityReport.effectivePromptTokens).toBe(
      first.fidelityReport.promptTokens,
    );

    // Re-compile with the same content; it should be warm now.
    const second = engine.compile({ maxTokens: 100_000, sections });
    expect(second.fidelityReport.warmTokens).toBeGreaterThan(0);
    expect(second.fidelityReport.warmFraction).toBeCloseTo(1, 10);
    expect(second.fidelityReport.effectivePromptTokens).toBeLessThan(
      second.fidelityReport.promptTokens,
    );
  });

  it('warm content boosts fidelity above cold-only baseline', () => {
    const model = new LinearFidelityModel(0.5);
    const cold = new HomeostaticContextEngine({ fidelityModel: model });
    const tracker = new LRUEncodingTracker({ threadId: 't2' });
    const warm = new HomeostaticContextEngine({
      fidelityModel: model,
      encoding: tracker,
      warmDiscount: 0.0,
    });

    const text = 'long shared system prompt.\n\nmore shared content.';
    const sections = [makeSection('s', text)];

    const coldPlan = cold.compile({ maxTokens: 100_000, sections });
    // First warm-engine call records; second sees warm content.
    warm.compile({ maxTokens: 100_000, sections });
    const warmPlan = warm.compile({ maxTokens: 100_000, sections });

    expect(warmPlan.fidelityReport.fidelity).toBeGreaterThan(
      coldPlan.fidelityReport.fidelity,
    );
  });

  it('reports warmFraction and effectivePromptTokens on every plan', () => {
    const engine = new HomeostaticContextEngine({
      fidelityModel: new LinearFidelityModel(0.4),
      encoding: new LRUEncodingTracker({ threadId: 't3' }),
    });
    const plan = engine.compile({
      maxTokens: 100_000,
      sections: [makeSection('a', 'novel content here.')],
    });
    expect(plan.fidelityReport).toMatchObject({
      warmTokens: 0,
      warmFraction: 0,
    });
    expect(plan.fidelityReport.effectivePromptTokens).toBe(
      plan.fidelityReport.promptTokens,
    );
  });

  it('evaluate() does not mutate encoding tracker state', () => {
    const tracker = new LRUEncodingTracker({ threadId: 't4' });
    const engine = new HomeostaticContextEngine({
      fidelityModel: new LinearFidelityModel(0.4),
      encoding: tracker,
    });
    // Build a plan via the compiler directly (no record).
    const plan = {
      sections: [
        {
          id: 's',
          source: 'memory' as const,
          content: 'evaluator content.',
          priority: 50,
          budgetTokens: 10,
          actualTokens: 10,
          truncated: false,
        },
      ],
      droppedSections: [],
      totalTokens: 10,
      promptText: 'evaluator content.',
      hadTruncation: false,
    };
    engine.evaluate(plan);
    expect(tracker.snapshot().size).toBe(0);
  });
});
