/**
 * Tests for streaming runtime and SSE utilities.
 */

import { describe, it, expect, vi } from 'vitest';
import { eventToSSE, streamToSSE, streamTokens } from '../src/streaming';
import type { TraceEvent, TokenStreamedEvent } from '../src/types/events';

// ── eventToSSE ──

describe('eventToSSE', () => {
  it('serializes a trace event as SSE format', () => {
    const event: TokenStreamedEvent = {
      id: 'evt_1',
      type: 'token_streamed',
      runId: 'run_1',
      agentId: 'agent_1',
      turnIndex: 0,
      timestamp: 1000,
      data: { token: 'Hello', tokenIndex: 0 },
    };

    const sse = eventToSSE(event);
    expect(sse).toContain('event: token_streamed\n');
    expect(sse).toContain('data: ');
    expect(sse).toMatch(/\n\n$/);

    // Parse the data line
    const dataLine = sse.split('\n').find((l) => l.startsWith('data: '))!;
    const parsed = JSON.parse(dataLine.slice(6));
    expect(parsed.type).toBe('token_streamed');
    expect(parsed.data.token).toBe('Hello');
  });

  it('handles events without turnIndex', () => {
    const event: TraceEvent = {
      id: 'evt_2',
      type: 'run_started',
      runId: 'run_1',
      agentId: 'agent_1',
      timestamp: 2000,
      data: { input: 'test' },
    };

    const sse = eventToSSE(event);
    expect(sse).toContain('event: run_started\n');
    const dataLine = sse.split('\n').find((l) => l.startsWith('data: '))!;
    const parsed = JSON.parse(dataLine.slice(6));
    expect(parsed.turnIndex).toBeUndefined();
  });
});

// ── streamTokens ──

describe('streamTokens', () => {
  it('extracts tokens from a mixed event stream', async () => {
    const events: TraceEvent[] = [
      {
        id: 'evt_1', type: 'run_started', runId: 'r1', agentId: 'a1',
        timestamp: 1, data: { input: 'hi' },
      },
      {
        id: 'evt_2', type: 'token_streamed', runId: 'r1', agentId: 'a1',
        timestamp: 2, data: { token: 'Hello', tokenIndex: 0 },
      },
      {
        id: 'evt_3', type: 'token_streamed', runId: 'r1', agentId: 'a1',
        timestamp: 3, data: { token: ' world', tokenIndex: 1 },
      },
      {
        id: 'evt_4', type: 'run_completed', runId: 'r1', agentId: 'a1',
        timestamp: 4, data: { output: 'Hello world', state: 'completed', turnCount: 1, totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      },
    ];

    async function* toAsync(items: TraceEvent[]): AsyncGenerator<TraceEvent> {
      for (const item of items) yield item;
    }

    const tokens: string[] = [];
    for await (const token of streamTokens(toAsync(events))) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['Hello', ' world']);
  });

  it('yields nothing for stream with no token events', async () => {
    async function* empty(): AsyncGenerator<TraceEvent> {
      yield {
        id: 'evt_1', type: 'run_started', runId: 'r1', agentId: 'a1',
        timestamp: 1, data: { input: 'hi' },
      } as TraceEvent;
    }

    const tokens: string[] = [];
    for await (const token of streamTokens(empty())) {
      tokens.push(token);
    }

    expect(tokens).toEqual([]);
  });
});

// ── streamToSSE ──

describe('streamToSSE', () => {
  it('produces a ReadableStream of SSE strings', async () => {
    const events: TraceEvent[] = [
      {
        id: 'evt_1', type: 'token_streamed', runId: 'r1', agentId: 'a1',
        timestamp: 1, data: { token: 'Hi', tokenIndex: 0 },
      },
    ];

    async function* toAsync(items: TraceEvent[]): AsyncGenerator<TraceEvent> {
      for (const item of items) yield item;
    }

    const stream = streamToSSE(toAsync(events));
    expect(stream).toBeInstanceOf(ReadableStream);

    const reader = stream.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(value).toContain('event: token_streamed');
    expect(value).toContain('"token":"Hi"');

    const { done: done2 } = await reader.read();
    expect(done2).toBe(true);
  });
});

// ── Token event emission in runtime (unit-level) ──

describe('token_streamed event', () => {
  it('EventBus emits token_streamed properly', async () => {
    const { EventBus } = await import('../src/events/EventBus');
    const bus = new EventBus();

    const received: TraceEvent[] = [];
    bus.on('token_streamed', (event) => received.push(event));

    const event: TokenStreamedEvent = {
      id: 'evt_tok_1',
      type: 'token_streamed',
      runId: 'run_1',
      agentId: 'agent_1',
      turnIndex: 0,
      timestamp: Date.now(),
      data: { token: 'test', tokenIndex: 0 },
    };

    bus.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('token_streamed');
  });
});
