import { describe, it, expect, vi } from 'vitest';
import {
  DeterministicCompactor,
  LLMRewriteCompactor,
  DEFAULT_PROTECTED_SOURCES,
  type CompactionRequest,
} from '../src/context/Compactor';
import {
  HomeostaticContextEngine,
  type CompactionTrigger,
} from '../src/context/HomeostaticContextEngine';
import { LinearFidelityModel } from '../src/context/FidelityModel';
import type { ContextSectionInput } from '../src/types/context';

function sec(
  id: string,
  source: ContextSectionInput['source'],
  tokens: number,
  priority: number,
): ContextSectionInput {
  return {
    id,
    source,
    content: 'a'.repeat(tokens * 4),
    priority,
  };
}

function buildTrigger(sections: ContextSectionInput[]): {
  trigger: CompactionTrigger;
  request: CompactionRequest;
} {
  const model = new LinearFidelityModel(0.4); // pGate(0.8)=50k
  const engine = new HomeostaticContextEngine({
    fidelityModel: model,
    fidelityTarget: 0.8,
    compactionThreshold: 0.5, // trigger at >= 25k
  });
  const plan = engine.compile({ maxTokens: 200_000, sections });
  const trigger: CompactionTrigger = { ...plan.fidelityReport, plan };
  const request: CompactionRequest = {
    trigger,
    fidelityModel: model,
    fidelityTarget: 0.8,
    compactionThreshold: 0.5,
  };
  return { trigger, request };
}

describe('DeterministicCompactor', () => {
  it('drops lowest-priority compactable sections until under target', async () => {
    const { request } = buildTrigger([
      sec('sys', 'system', 1_000, 100),
      sec('mem-low', 'memory', 20_000, 10),
      sec('mem-mid', 'memory', 5_000, 20),
      sec('mem-high', 'memory', 5_000, 90),
    ]);
    // total ~31k, target = 0.5 * 50k = 25k → shed ≥ 6k.

    const compactor = new DeterministicCompactor();
    const result = await compactor.compact(request);

    const totalAfter = result.sections.reduce((acc, s) => acc + Math.ceil(s.content.length / 4), 0);
    expect(totalAfter).toBeLessThanOrEqual(25_000);

    // System never touched.
    const sys = result.sections.find((s) => s.id === 'sys');
    expect(sys?.content.length).toBeGreaterThan(0);

    // Low-priority memory shed first.
    const dropAction = result.actions.find((a) => a.sectionId === 'mem-low');
    expect(dropAction?.kind === 'dropped' || dropAction?.kind === 'truncated').toBe(true);
  });

  it('truncates rather than drops when a section is larger than excess', async () => {
    const { request } = buildTrigger([
      sec('sys', 'system', 1_000, 100),
      sec('mem-big', 'memory', 30_000, 10), // alone exceeds budget
    ]);
    // total ~31k, target 25k → need to shed ~6k from a 30k section.

    const compactor = new DeterministicCompactor();
    const result = await compactor.compact(request);

    const big = result.sections.find((s) => s.id === 'mem-big');
    expect(big).toBeDefined();
    // It should have been truncated, not dropped.
    expect(big!.content.length).toBeLessThan(30_000 * 4);
    expect(big!.content.length).toBeGreaterThan(0);

    const action = result.actions.find((a) => a.sectionId === 'mem-big');
    expect(action?.kind).toBe('truncated');
  });

  it('does not touch protected sources even at low priority', async () => {
    const { request } = buildTrigger([
      sec('inst', 'instructions', 30_000, 1), // protected even with low priority
      sec('mem', 'memory', 2_000, 50),
    ]);
    // total ~32k, target 25k. Compactor must shed from memory only.

    const compactor = new DeterministicCompactor();
    const result = await compactor.compact(request);

    const inst = result.sections.find((s) => s.id === 'inst');
    expect(inst?.content.length).toBe(30_000 * 4); // untouched
  });

  it('no-op when already under target', async () => {
    const { request } = buildTrigger([sec('mem', 'memory', 1_000, 50)]);
    const compactor = new DeterministicCompactor();
    const result = await compactor.compact(request);
    expect(result.tokensShed).toBe(0);
    expect(result.actions.every((a) => a.kind === 'kept')).toBe(true);
  });

  it('honors a custom protectedSources override', async () => {
    const { request } = buildTrigger([
      sec('mem', 'memory', 30_000, 10),
      sec('inst', 'instructions', 1_000, 5),
    ]);
    const compactor = new DeterministicCompactor();
    const result = await compactor.compact({
      ...request,
      protectedSources: new Set(['memory']),
    });
    const mem = result.sections.find((s) => s.id === 'mem');
    expect(mem?.content.length).toBe(30_000 * 4); // protected now
    const inst = result.actions.find((a) => a.sectionId === 'inst');
    // instructions may be kept or shed since it's no longer protected;
    // total tokens were already small enough so likely kept.
    expect(inst).toBeDefined();
  });
});

describe('LLMRewriteCompactor', () => {
  it('calls summarise for compactable sections and uses the result', async () => {
    const summarise = vi.fn(async ({ budgetTokens }: { budgetTokens: number }) => {
      return 'SUMMARY:' + 'x'.repeat(Math.max(0, budgetTokens) * 4);
    });
    const { request } = buildTrigger([
      sec('sys', 'system', 1_000, 100),
      sec('mem', 'memory', 30_000, 10),
    ]);

    const compactor = new LLMRewriteCompactor(summarise, 0.3);
    const result = await compactor.compact(request);

    expect(summarise).toHaveBeenCalled();
    const action = result.actions.find((a) => a.sectionId === 'mem');
    expect(action?.kind).toBe('summarised');
    const mem = result.sections.find((s) => s.id === 'mem');
    expect(mem?.content.startsWith('SUMMARY:')).toBe(true);
    expect(mem!.content.length).toBeLessThan(30_000 * 4);
  });

  it('falls back to deterministic when summarise throws', async () => {
    const summarise = vi.fn(async () => {
      throw new Error('boom');
    });
    const { request } = buildTrigger([
      sec('sys', 'system', 1_000, 100),
      sec('mem', 'memory', 30_000, 10),
    ]);
    const compactor = new LLMRewriteCompactor(summarise);
    const result = await compactor.compact(request);

    const failureNote = result.actions.find((a) => a.reason?.includes('summarise failed'));
    expect(failureNote).toBeDefined();

    const totalAfter = result.sections.reduce((acc, s) => acc + Math.ceil(s.content.length / 4), 0);
    expect(totalAfter).toBeLessThanOrEqual(25_000);
  });

  it('skips when summary is not smaller than original', async () => {
    const summarise = vi.fn(async ({ content }: { content: string }) => content + 'extra');
    const { request } = buildTrigger([
      sec('sys', 'system', 1_000, 100),
      sec('mem', 'memory', 30_000, 10),
    ]);
    const compactor = new LLMRewriteCompactor(summarise);
    const result = await compactor.compact(request);

    // summary not useful → falls through to deterministic
    const action = result.actions.find((a) => a.sectionId === 'mem');
    expect(['truncated', 'dropped']).toContain(action!.kind);
  });

  it('rejects invalid shrinkRatio', () => {
    const noop = async () => '';
    expect(() => new LLMRewriteCompactor(noop, 0)).toThrow();
    expect(() => new LLMRewriteCompactor(noop, 1)).toThrow();
    expect(() => new LLMRewriteCompactor(noop, -0.1)).toThrow();
  });
});

describe('DEFAULT_PROTECTED_SOURCES', () => {
  it('contains the governed sources', () => {
    expect(DEFAULT_PROTECTED_SOURCES.has('system')).toBe(true);
    expect(DEFAULT_PROTECTED_SOURCES.has('instructions')).toBe(true);
    expect(DEFAULT_PROTECTED_SOURCES.has('policy_overlay')).toBe(true);
    expect(DEFAULT_PROTECTED_SOURCES.has('memory')).toBe(false);
    expect(DEFAULT_PROTECTED_SOURCES.has('tools')).toBe(false);
  });
});
