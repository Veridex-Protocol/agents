/**
 * @packageDocumentation
 * @module EventLog
 * @description
 * Append-only event log for the Veridex Agent Fabric runtime.
 * Queryable by run, turn, and event type.
 */

import type { TraceEvent, TraceEventType } from '../types/events';

export class EventLog {
  private events: TraceEvent[] = [];

  /** Append an event to the log. */
  append(event: TraceEvent): void {
    this.events.push(event);
  }

  /** Get all events. */
  getAll(): readonly TraceEvent[] {
    return this.events;
  }

  /** Get events by run ID. */
  getByRun(runId: string): TraceEvent[] {
    return this.events.filter((e) => e.runId === runId);
  }

  /** Get events by turn index within a run. */
  getByTurn(runId: string, turnIndex: number): TraceEvent[] {
    return this.events.filter(
      (e) => e.runId === runId && e.turnIndex === turnIndex,
    );
  }

  /** Get events by type. */
  getByType(type: TraceEventType): TraceEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  /** Get events matching a predicate. */
  query(predicate: (event: TraceEvent) => boolean): TraceEvent[] {
    return this.events.filter(predicate);
  }

  /** Get the total count of events. */
  get size(): number {
    return this.events.length;
  }

  /** Get event at a specific position. */
  at(index: number): TraceEvent | undefined {
    return this.events[index];
  }

  /** Get events since a given position (for incremental reads). */
  since(position: number): TraceEvent[] {
    return this.events.slice(position);
  }

  /** Clear the log. */
  clear(): void {
    this.events = [];
  }
}
