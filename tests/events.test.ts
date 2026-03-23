import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../src/events/EventBus';
import { EventLog } from '../src/events/EventLog';
import type { TraceEvent, RunStartedEvent, ToolExecutedEvent } from '../src/types/events';

function makeEvent(
  overrides: Partial<TraceEvent> & { type: TraceEvent['type'] },
): TraceEvent {
  return {
    id: `evt_${Date.now()}`,
    runId: 'run_1',
    agentId: 'agent_1',
    timestamp: Date.now(),
    ...overrides,
  } as TraceEvent;
}

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('emits to typed subscribers', () => {
    const handler = vi.fn();
    bus.on('run_started', handler);

    const event = makeEvent({
      type: 'run_started',
      data: { input: 'hello' },
    }) as RunStartedEvent;
    bus.emit(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('does not emit to unrelated type subscribers', () => {
    const handler = vi.fn();
    bus.on('run_completed', handler);

    bus.emit(
      makeEvent({ type: 'run_started', data: { input: 'hello' } }) as RunStartedEvent,
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it('onAny receives all events', () => {
    const handler = vi.fn();
    bus.onAny(handler);

    const e1 = makeEvent({ type: 'run_started', data: { input: 'a' } }) as RunStartedEvent;
    const e2 = makeEvent({
      type: 'tool_executed',
      data: { toolName: 'x', success: true, durationMs: 10 },
    }) as ToolExecutedEvent;

    bus.emit(e1);
    bus.emit(e2);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('once fires handler only once', () => {
    const handler = vi.fn();
    bus.once('run_started', handler);

    const event = makeEvent({ type: 'run_started', data: { input: 'a' } }) as RunStartedEvent;
    bus.emit(event);
    bus.emit(event);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('off unsubscribes', () => {
    const handler = vi.fn();
    bus.on('run_started', handler);
    bus.off('run_started', handler);

    bus.emit(
      makeEvent({ type: 'run_started', data: { input: 'a' } }) as RunStartedEvent,
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it('returns unsubscribe function from on()', () => {
    const handler = vi.fn();
    const unsub = bus.on('run_started', handler);
    unsub();

    bus.emit(
      makeEvent({ type: 'run_started', data: { input: 'a' } }) as RunStartedEvent,
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it('returns unsubscribe function from onAny()', () => {
    const handler = vi.fn();
    const unsub = bus.onAny(handler);
    unsub();

    bus.emit(
      makeEvent({ type: 'run_started', data: { input: 'a' } }) as RunStartedEvent,
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it('isolates handler errors', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    bus.on('run_started', bad);
    bus.on('run_started', good);

    bus.emit(
      makeEvent({ type: 'run_started', data: { input: 'a' } }) as RunStartedEvent,
    );

    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it('clear removes all handlers', () => {
    bus.on('run_started', vi.fn());
    bus.onAny(vi.fn());
    bus.clear();

    expect(bus.listenerCount()).toBe(0);
  });

  it('listenerCount returns correct counts', () => {
    bus.on('run_started', vi.fn());
    bus.on('run_started', vi.fn());
    bus.onAny(vi.fn());

    expect(bus.listenerCount('run_started')).toBe(3); // 2 typed + 1 wildcard
    expect(bus.listenerCount()).toBe(3); // 2 typed + 1 wildcard
  });
});

describe('EventLog', () => {
  let log: EventLog;

  beforeEach(() => {
    log = new EventLog();
  });

  it('appends and retrieves events', () => {
    const e = makeEvent({ type: 'run_started', data: { input: 'x' } }) as RunStartedEvent;
    log.append(e);

    expect(log.size).toBe(1);
    expect(log.getAll()[0]).toBe(e);
  });

  it('filters by runId', () => {
    log.append(makeEvent({ type: 'run_started', runId: 'r1', data: { input: 'a' } }) as RunStartedEvent);
    log.append(makeEvent({ type: 'run_started', runId: 'r2', data: { input: 'b' } }) as RunStartedEvent);

    expect(log.getByRun('r1')).toHaveLength(1);
    expect(log.getByRun('r2')).toHaveLength(1);
    expect(log.getByRun('r3')).toHaveLength(0);
  });

  it('filters by type', () => {
    log.append(makeEvent({ type: 'run_started', data: { input: 'a' } }) as RunStartedEvent);
    log.append(makeEvent({
      type: 'tool_executed',
      data: { toolName: 'x', success: true, durationMs: 10 },
    }) as ToolExecutedEvent);

    expect(log.getByType('run_started')).toHaveLength(1);
    expect(log.getByType('tool_executed')).toHaveLength(1);
  });

  it('filters by turn', () => {
    log.append(makeEvent({ type: 'run_started', runId: 'r1', turnIndex: 0, data: { input: 'a' } }) as RunStartedEvent);
    log.append(makeEvent({ type: 'run_started', runId: 'r1', turnIndex: 1, data: { input: 'b' } }) as RunStartedEvent);

    expect(log.getByTurn('r1', 0)).toHaveLength(1);
    expect(log.getByTurn('r1', 1)).toHaveLength(1);
  });

  it('at() returns event at index', () => {
    const e = makeEvent({ type: 'run_started', data: { input: 'a' } }) as RunStartedEvent;
    log.append(e);

    expect(log.at(0)).toBe(e);
    expect(log.at(99)).toBeUndefined();
  });

  it('since() returns events from position', () => {
    log.append(makeEvent({ type: 'run_started', data: { input: 'a' } }) as RunStartedEvent);
    log.append(makeEvent({ type: 'run_started', data: { input: 'b' } }) as RunStartedEvent);
    log.append(makeEvent({ type: 'run_started', data: { input: 'c' } }) as RunStartedEvent);

    expect(log.since(1)).toHaveLength(2);
    expect(log.since(3)).toHaveLength(0);
  });

  it('query() filters with predicate', () => {
    log.append(makeEvent({ type: 'run_started', runId: 'r1', data: { input: 'a' } }) as RunStartedEvent);
    log.append(makeEvent({ type: 'run_started', runId: 'r2', data: { input: 'b' } }) as RunStartedEvent);

    const results = log.query((e) => e.runId === 'r1');
    expect(results).toHaveLength(1);
  });

  it('clear() empties the log', () => {
    log.append(makeEvent({ type: 'run_started', data: { input: 'a' } }) as RunStartedEvent);
    log.clear();

    expect(log.size).toBe(0);
  });
});
