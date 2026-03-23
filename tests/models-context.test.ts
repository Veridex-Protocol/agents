import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelRegistry } from '../src/models/ModelRegistry';
import { ContextCompiler } from '../src/context/ContextCompiler';
import type { ModelProvider, ModelResponse } from '../src/types/models';

function mockProvider(name: string, response?: ModelResponse): ModelProvider {
  return {
    name,
    complete: vi.fn(async () => response ?? {
      content: `response from ${name}`,
      model: `${name}-model`,
      provider: name,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      finishReason: 'stop' as const,
    }),
  };
}

// ── ModelRegistry ──

describe('ModelRegistry', () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    registry = new ModelRegistry();
  });

  it('registers and retrieves a provider', () => {
    const provider = mockProvider('openai');
    registry.register(provider);

    expect(registry.get('openai')).toBe(provider);
    expect(registry.has('openai')).toBe(true);
  });

  it('returns undefined for unknown provider', () => {
    expect(registry.get('unknown')).toBeUndefined();
  });

  it('lists providers', () => {
    registry.register(mockProvider('openai'));
    registry.register(mockProvider('anthropic'));

    expect(registry.list().sort()).toEqual(['anthropic', 'openai']);
  });

  it('removes a provider', () => {
    registry.register(mockProvider('openai'));
    expect(registry.remove('openai')).toBe(true);
    expect(registry.has('openai')).toBe(false);
  });

  it('completeWithFallback uses primary provider', async () => {
    const primary = mockProvider('primary');
    registry.register(primary);

    const result = await registry.completeWithFallback('primary', [
      { role: 'user', content: 'Hello' },
    ]);

    expect(result.content).toBe('response from primary');
    expect(primary.complete).toHaveBeenCalledOnce();
  });

  it('completeWithFallback falls back on error', async () => {
    const failing: ModelProvider = {
      name: 'failing',
      complete: vi.fn(async () => {
        throw new Error('API error');
      }),
    };
    const fallback = mockProvider('fallback');

    registry.register(failing);
    registry.register(fallback);

    const result = await registry.completeWithFallback(
      'failing',
      [{ role: 'user', content: 'Hello' }],
      { fallbackProviders: ['fallback'] },
    );

    expect(result.content).toBe('response from fallback');
    expect(failing.complete).toHaveBeenCalledOnce();
    expect(fallback.complete).toHaveBeenCalledOnce();
  });

  it('completeWithFallback throws when all fail', async () => {
    const failing: ModelProvider = {
      name: 'failing',
      complete: vi.fn(async () => {
        throw new Error('fail');
      }),
    };
    registry.register(failing);

    await expect(
      registry.completeWithFallback('failing', [{ role: 'user', content: 'Hello' }]),
    ).rejects.toThrow('fail');
  });

  it('completeWithFallback throws for missing provider', async () => {
    await expect(
      registry.completeWithFallback('nonexistent', [{ role: 'user', content: 'Hello' }]),
    ).rejects.toThrow('not registered');
  });
});

// ── ContextCompiler ──

describe('ContextCompiler', () => {
  let compiler: ContextCompiler;

  beforeEach(() => {
    compiler = new ContextCompiler();
  });

  it('compiles sections within budget', () => {
    const plan = compiler.compile({
      maxTokens: 1000,
      sections: [
        { id: 'sys', source: 'system', content: 'Instructions', priority: 100 },
        { id: 'ctx', source: 'context', content: 'Context data', priority: 50 },
      ],
    });

    expect(plan.sections).toHaveLength(2);
    expect(plan.totalTokens).toBeLessThanOrEqual(1000);
    expect(plan.hadTruncation).toBe(false);
  });

  it('truncates low-priority sections when over budget', () => {
    const longContent = 'x'.repeat(4000); // ~1000 tokens

    const plan = compiler.compile({
      maxTokens: 500,
      sections: [
        { id: 'high', source: 'system', content: 'Important', priority: 100 },
        { id: 'low', source: 'context', content: longContent, priority: 10 },
      ],
    });

    expect(plan.hadTruncation).toBe(true);
    const highSection = plan.sections.find((s) => s.id === 'high');
    expect(highSection!.wasTruncated).toBe(false);
    expect(highSection!.content).toBe('Important');
  });

  it('respects section-level budgets', () => {
    const plan = compiler.compile({
      maxTokens: 10000,
      sections: [
        {
          id: 'limited',
          source: 'context',
          content: 'x'.repeat(4000),
          priority: 50,
          budgetTokens: 100,
        },
      ],
    });

    const section = plan.sections[0];
    expect(section.actualTokens).toBeLessThanOrEqual(100);
    expect(section.wasTruncated).toBe(true);
  });

  it('supports head truncation strategy', () => {
    const content = 'AAAA' + 'BBBB'.repeat(100);
    const plan = compiler.compile({
      maxTokens: 10,
      sections: [
        { id: 'test', source: 'context', content, priority: 50, truncation: 'head' },
      ],
    });

    const section = plan.sections[0];
    // Head truncation keeps the end of the content
    expect(section.content).toContain('BBBB');
    expect(section.content).not.toContain('AAAA');
  });

  it('supports middle truncation strategy', () => {
    const content = 'START' + 'x'.repeat(2000) + 'END';
    const plan = compiler.compile({
      maxTokens: 20,
      sections: [
        { id: 'test', source: 'context', content, priority: 50, truncation: 'middle' },
      ],
    });

    const section = plan.sections[0];
    expect(section.content).toContain('START');
    expect(section.content).toContain('END');
    expect(section.content).toContain('[truncated]');
  });

  it('supports drop truncation strategy', () => {
    const plan = compiler.compile({
      maxTokens: 1,
      sections: [
        { id: 'test', source: 'context', content: 'x'.repeat(1000), priority: 50, truncation: 'drop' },
      ],
    });

    expect(plan.sections[0].content).toBe('');
  });

  it('estimateTokens uses ~4 chars per token heuristic', () => {
    expect(compiler.estimateTokens('')).toBe(0);
    expect(compiler.estimateTokens('abcd')).toBe(1);
    expect(compiler.estimateTokens('abcdefgh')).toBe(2);
  });

  it('orders sections by priority (highest first)', () => {
    const plan = compiler.compile({
      maxTokens: 100,
      sections: [
        { id: 'low', source: 'context', content: 'L', priority: 1 },
        { id: 'high', source: 'system', content: 'H', priority: 100 },
        { id: 'mid', source: 'context', content: 'M', priority: 50 },
      ],
    });

    // Higher priority sections should be compiled first (and get budget first)
    expect(plan.sections[0].id).toBe('high');
  });
});
