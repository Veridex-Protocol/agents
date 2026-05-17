import { describe, it, expect, vi } from 'vitest';
import { AgentRuntime } from '../src/runtime/AgentRuntime';
import {
  HomeostaticContextEngine,
  DeterministicCompactor,
  LinearFidelityModel,
} from '../src/context';
import type {
  ModelProvider,
  ModelResponse,
  ModelMessage,
  ModelCompletionOptions,
} from '../src/types/models';
import type { AgentDefinition } from '../src/types/agent';
import type {
  TraceEvent,
  ContextFidelityEvent,
  ContextCompactedEvent,
} from '../src/types/events';

function provider(responses: ModelResponse[]): ModelProvider {
  let i = 0;
  return {
    name: 'mock',
    complete: vi.fn(async (_m: ModelMessage[], _o?: ModelCompletionOptions) => {
      const r = responses[i] ?? responses[responses.length - 1];
      i++;
      return r;
    }),
  };
}

function resp(content: string): ModelResponse {
  return {
    content,
    model: 'mock',
    provider: 'mock',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  };
}

function definition(): AgentDefinition {
  return {
    id: 'homeo-agent',
    name: 'Homeo Agent',
    model: { provider: 'mock', model: 'mock' },
    instructions: 'be brief',
  };
}

describe('AgentRuntime + HomeostaticContextEngine', () => {
  it('emits a context_fidelity event when homeostatic engine is provided', async () => {
    const runtime = new AgentRuntime(definition(), {
      modelProviders: { mock: provider([resp('ok')]) },
      homeostatic: { modelId: 'gpt-4o' },
    });

    const events: TraceEvent[] = [];
    runtime.events.on('context_fidelity', (e) => events.push(e));

    await runtime.run('hi');

    expect(events).toHaveLength(1);
    const ev = events[0] as ContextFidelityEvent;
    expect(ev.data.modelId).toMatch(/gpt-4o/);
    expect(ev.data.fidelityTarget).toBeGreaterThan(0);
    expect(ev.data.fidelityTarget).toBeLessThan(1);
    expect(ev.data.promptTokens).toBeGreaterThan(0);
  });

  it('does not emit context_fidelity when homeostatic is disabled', async () => {
    const runtime = new AgentRuntime(definition(), {
      modelProviders: { mock: provider([resp('ok')]) },
    });

    const events: TraceEvent[] = [];
    runtime.events.on('context_fidelity', (e) => events.push(e));

    await runtime.run('hi');
    expect(events).toHaveLength(0);
  });

  it('emits context_compacted when compactor runs', async () => {
    // Aggressive thresholds: very high degradation + tiny target so any
    // non-trivial prompt fires a trigger.
    const engine = new HomeostaticContextEngine({
      fidelityModel: new LinearFidelityModel(80), // pGate(0.999)=~12 tokens
      fidelityTarget: 0.999,
      compactionThreshold: 0.01,
    });

    const runtime = new AgentRuntime(definition(), {
      modelProviders: { mock: provider([resp('ok')]) },
      homeostatic: engine,
      compactor: new DeterministicCompactor(),
    });

    const compactedEvents: ContextCompactedEvent[] = [];
    runtime.events.on('context_compacted', (e) =>
      compactedEvents.push(e as ContextCompactedEvent),
    );

    await runtime.run('hi');
    expect(compactedEvents.length).toBeGreaterThanOrEqual(1);
    expect(compactedEvents[0].data.compactorId).toBe('deterministic');
  });

  it('accepts a HomeostaticContextEngineOptions object directly', async () => {
    const runtime = new AgentRuntime(definition(), {
      modelProviders: { mock: provider([resp('ok')]) },
      homeostatic: { modelId: 'claude-3.5-sonnet', fidelityTarget: 0.9 },
    });

    const events: ContextFidelityEvent[] = [];
    runtime.events.on('context_fidelity', (e) =>
      events.push(e as ContextFidelityEvent),
    );

    await runtime.run('hi');
    expect(events[0].data.modelId).toMatch(/claude-3\.5-sonnet/);
    expect(events[0].data.fidelityTarget).toBeCloseTo(0.9, 5);
  });
});
