import { describe, it, expect } from 'vitest';
import {
  ModelRouter,
  costOptimisedStrategy,
  latencyOptimisedStrategy,
  qualityOptimisedStrategy,
  weightedStrategy,
  type RoutableModel,
} from '../src/routing';

const cheap: RoutableModel = {
  providerId: 'p',
  modelId: 'cheap',
  taskKinds: ['generator', 'classifier'],
  hints: {
    inputCostPer1kUSD: 0.1,
    outputCostPer1kUSD: 0.1,
    latencyMs: 500,
    quality: 0.6,
    contextTokens: 8000,
    vendor: 'acme',
    capabilities: { json: true, tools: false, streaming: true },
    tags: ['stable'],
  },
};
const fast: RoutableModel = {
  providerId: 'p',
  modelId: 'fast',
  taskKinds: ['generator'],
  hints: {
    inputCostPer1kUSD: 0.5,
    outputCostPer1kUSD: 0.5,
    latencyMs: 100,
    quality: 0.7,
    contextTokens: 4000,
    vendor: 'acme',
    capabilities: { json: true, tools: true },
    tags: ['stable'],
  },
};
const smart: RoutableModel = {
  providerId: 'p',
  modelId: 'smart',
  taskKinds: ['generator', 'planner'],
  hints: {
    inputCostPer1kUSD: 5,
    outputCostPer1kUSD: 5,
    latencyMs: 1500,
    quality: 0.95,
    contextTokens: 128000,
    vendor: 'big',
    capabilities: { json: true, tools: true, longContext: true },
    tags: ['premium'],
  },
};

function build(): ModelRouter {
  const r = new ModelRouter();
  r.register(cheap);
  r.register(fast);
  r.register(smart);
  return r;
}

describe('ModelRouter', () => {
  it('throws on duplicate registration', () => {
    const r = new ModelRouter();
    r.register(cheap);
    expect(() => r.register(cheap)).toThrow(/duplicate/);
  });

  it('cost strategy picks cheapest', () => {
    const r = build();
    const d = r.route({ taskKind: 'generator', strategy: costOptimisedStrategy });
    expect(d.model.modelId).toBe('cheap');
  });

  it('latency strategy picks fastest', () => {
    const r = build();
    const d = r.route({ taskKind: 'generator', strategy: latencyOptimisedStrategy });
    expect(d.model.modelId).toBe('fast');
  });

  it('quality strategy picks highest quality', () => {
    const r = build();
    const d = r.route({ taskKind: 'generator', strategy: qualityOptimisedStrategy });
    expect(d.model.modelId).toBe('smart');
  });

  it('weighted strategy reports its weights in the id', () => {
    const s = weightedStrategy({ cost: 0.4, latency: 0.3, quality: 0.3 });
    expect(s.id).toMatch(/^weighted/);
  });

  it('filters by required capability', () => {
    const r = build();
    const d = r.route({
      taskKind: 'generator',
      strategy: costOptimisedStrategy,
      constraints: { requiredCapabilities: ['tools'] },
    });
    expect(['fast', 'smart']).toContain(d.model.modelId);
  });

  it('rejects when no candidate satisfies constraints', () => {
    const r = build();
    expect(() =>
      r.route({
        taskKind: 'generator',
        strategy: costOptimisedStrategy,
        constraints: { minQuality: 0.99 },
      }),
    ).toThrow(/no candidate satisfies/);
  });

  it('respects vendor exclusion', () => {
    const r = build();
    const d = r.route({
      taskKind: 'generator',
      strategy: costOptimisedStrategy,
      constraints: { excludeVendors: ['acme'] },
    });
    expect(d.model.modelId).toBe('smart');
  });

  it('filters by taskKind', () => {
    const r = build();
    const d = r.route({ taskKind: 'planner', strategy: qualityOptimisedStrategy });
    expect(d.model.modelId).toBe('smart');
  });
});
