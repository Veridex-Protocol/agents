import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReplayProvider,
  TraceRecorder,
  compareTraces,
  serializeGoldenTrace,
  deserializeGoldenTrace,
} from '../src/testing';
import type { RecordedInteraction, GoldenTrace } from '../src/testing';
import type { RunResult, Run } from '../src/types/runtime';
import type { TraceEvent } from '../src/types/events';

function makeInteraction(content: string, turnIndex = 0): RecordedInteraction {
  return {
    turnIndex,
    messages: [{ role: 'user', content: 'test' }],
    response: {
      content,
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
    },
  };
}

function makeRunResult(output: string, events: TraceEvent[] = []): RunResult {
  const createdAt = Date.now();
  const run: Run = {
    id: 'run_1',
    agentId: 'agent_1',
    state: 'completed',
    input: 'test input',
    turns: [],
    turnOutcomes: [],
    createdAt,
    updatedAt: createdAt,
    totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    policyDecisions: [],
    approvalDecisions: [],
  };
  const bootstrapReport = {
    agentId: run.agentId,
    generatedAt: createdAt,
    modelProviders: ['mock'],
    defaultModelProvider: 'mock',
    capabilityCount: 0,
    capabilitySources: [],
    activePolicyCount: 0,
    approvalManagerEnabled: true,
    checkpointManagerEnabled: false,
    transcriptStoreMode: 'memory' as const,
    transportAvailability: {
      mcp: false,
      acp: false,
      a2a: false,
    },
    veridex: {
      identityWired: false,
      paymentsWired: false,
      controlPlaneConnected: null,
    },
    defaults: {
      maxTurns: 25,
      contextTokenBudget: 4000,
      historyTurns: 6,
    },
  };

  const session = {
    runId: run.id,
    agentId: run.agentId,
    prompt: run.input,
    routedMatches: [],
    toolExecutionSummaries: [],
    streamEventSummary: [],
    checkpointRefs: [],
    transcript: {
      runId: run.id,
      mode: 'memory' as const,
      entryCount: 0,
    },
    transcriptEntries: [],
    bootstrapReport,
    approvalState: { status: 'none' as const },
    createdAt,
    updatedAt: createdAt,
  };

  return {
    run,
    output,
    events,
    usage: run.totalUsage,
    turnOutcomes: [],
    session,
    bootstrapReport,
  };
}

describe('ReplayProvider', () => {
  it('replays recorded interactions in order', async () => {
    const interactions = [
      makeInteraction('First response', 0),
      makeInteraction('Second response', 1),
    ];

    const provider = new ReplayProvider('test-replay', interactions);
    expect(provider.name).toBe('test-replay');

    const r1 = await provider.complete([{ role: 'user', content: 'hello' }]);
    expect(r1.content).toBe('First response');

    const r2 = await provider.complete([{ role: 'user', content: 'bye' }]);
    expect(r2.content).toBe('Second response');
  });

  it('throws when interactions exhausted', async () => {
    const provider = new ReplayProvider('test', [makeInteraction('Only one')]);

    await provider.complete([{ role: 'user', content: 'hello' }]);

    await expect(
      provider.complete([{ role: 'user', content: 'more' }]),
    ).rejects.toThrow();
  });

  it('resets replay index', async () => {
    const provider = new ReplayProvider('test', [makeInteraction('Hello!')]);
    await provider.complete([{ role: 'user', content: 'hi' }]);
    provider.reset();
    const r = await provider.complete([{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('Hello!');
  });

  it('tracks call count', async () => {
    const provider = new ReplayProvider('test', [
      makeInteraction('one'),
      makeInteraction('two'),
    ]);

    expect(provider.getCallCount()).toBe(0);
    await provider.complete([{ role: 'user', content: 'a' }]);
    expect(provider.getCallCount()).toBe(1);
    await provider.complete([{ role: 'user', content: 'b' }]);
    expect(provider.getCallCount()).toBe(2);
  });
});

describe('TraceRecorder', () => {
  it('records model interactions', () => {
    const recorder = new TraceRecorder();

    recorder.recordInteraction(
      0,
      [{ role: 'user', content: 'hello' }],
      {
        content: 'Hi!',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      },
    );

    const interactions = recorder.getInteractions();
    expect(interactions).toHaveLength(1);
    expect(interactions[0].response.content).toBe('Hi!');
  });

  it('records trace events', () => {
    const recorder = new TraceRecorder();

    const event: TraceEvent = {
      id: 'evt_1',
      type: 'run_started',
      runId: 'run_1',
      agentId: 'agent_1',
      timestamp: Date.now(),
      data: { input: 'test' },
    } as TraceEvent;

    recorder.recordEvent(event);
    expect(recorder.getEvents()).toHaveLength(1);
  });

  it('builds a golden trace', () => {
    const recorder = new TraceRecorder();

    recorder.recordInteraction(
      0,
      [{ role: 'user', content: 'hello' }],
      {
        content: 'Hi!',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      },
    );

    const trace = recorder.buildGoldenTrace(
      'trace_1', 'test-agent', 'hello', 'Hi!',
    );

    expect(trace.id).toBe('trace_1');
    expect(trace.agentId).toBe('test-agent');
    expect(trace.input).toBe('hello');
    expect(trace.expectedOutput).toBe('Hi!');
    expect(trace.interactions).toHaveLength(1);
  });

  it('resets recorded data', () => {
    const recorder = new TraceRecorder();
    recorder.recordInteraction(0, [{ role: 'user', content: 'hi' }], {
      content: 'Hello', finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    recorder.reset();
    expect(recorder.getInteractions()).toHaveLength(0);
    expect(recorder.getEvents()).toHaveLength(0);
  });
});

describe('compareTraces', () => {
  it('passes for matching output and events', () => {
    const golden: GoldenTrace = {
      id: 'g1',
      agentId: 'test',
      input: 'hello',
      expectedOutput: 'Hello there!',
      interactions: [makeInteraction('Hello there!')],
      expectedEvents: [{ type: 'run_started' }, { type: 'run_completed' }],
      createdAt: Date.now(),
    };

    const actual = makeRunResult('Hello there!', [
      { id: 'e1', type: 'run_started', runId: 'run_1', agentId: 'agent_1', timestamp: Date.now() } as TraceEvent,
      { id: 'e2', type: 'run_completed', runId: 'run_1', agentId: 'agent_1', timestamp: Date.now() } as TraceEvent,
    ]);

    const result = compareTraces(golden, actual);
    expect(result.passed).toBe(true);
    expect(result.outputMatch).toBe(true);
  });

  it('fails for different output', () => {
    const golden: GoldenTrace = {
      id: 'g1',
      agentId: 'test',
      input: 'hello',
      expectedOutput: 'Hello there!',
      interactions: [],
      expectedEvents: [],
      createdAt: Date.now(),
    };

    const actual = makeRunResult('Different output');
    const result = compareTraces(golden, actual);
    expect(result.passed).toBe(false);
    expect(result.outputMatch).toBe(false);
  });

  it('supports fuzzy output matching', () => {
    const golden: GoldenTrace = {
      id: 'g1',
      agentId: 'test',
      input: 'hello',
      expectedOutput: 'hello',
      interactions: [],
      expectedEvents: [],
      createdAt: Date.now(),
    };

    const actual = makeRunResult('I say HELLO to you!');
    const result = compareTraces(golden, actual, { fuzzyOutputMatch: true });
    expect(result.outputMatch).toBe(true);
  });

  it('detects event type mismatches', () => {
    const golden: GoldenTrace = {
      id: 'g1',
      agentId: 'test',
      input: 'test',
      expectedOutput: 'output',
      interactions: [],
      expectedEvents: [{ type: 'run_started' }],
      createdAt: Date.now(),
    };

    const actual = makeRunResult('output', [
      { id: 'e1', type: 'tool_executed', runId: 'run_1', agentId: 'agent_1', timestamp: Date.now() } as TraceEvent,
    ]);

    const result = compareTraces(golden, actual);
    expect(result.passed).toBe(false);
    expect(result.eventDiffs.some((d) => !d.match)).toBe(true);
  });
});

describe('Serialization', () => {
  it('round-trips golden traces', () => {
    const trace: GoldenTrace = {
      id: 'trace_1',
      agentId: 'test-agent',
      input: 'hello',
      expectedOutput: 'Hi!',
      interactions: [makeInteraction('Hi!')],
      expectedEvents: [{ type: 'run_started' }],
      createdAt: Date.now(),
    };

    const serialized = serializeGoldenTrace(trace);
    expect(typeof serialized).toBe('string');

    const deserialized = deserializeGoldenTrace(serialized);
    expect(deserialized.id).toBe('trace_1');
    expect(deserialized.agentId).toBe('test-agent');
    expect(deserialized.interactions).toHaveLength(1);
    expect(deserialized.interactions[0].response.content).toBe('Hi!');
  });
});
