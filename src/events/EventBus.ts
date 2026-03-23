/**
 * @packageDocumentation
 * @module EventBus
 * @description
 * Typed event emitter for the Veridex Agent Fabric runtime.
 * Supports on/off/emit/once with type-safe event discriminators.
 */

import type { TraceEvent, TraceEventType } from '../types/events';

export type EventHandler = (event: TraceEvent) => void;
export type TypedEventHandler<T extends TraceEvent> = (event: T) => void;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private wildcardHandlers = new Set<EventHandler>();

  /** Subscribe to a specific event type. */
  on(type: TraceEventType, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => this.off(type, handler);
  }

  /** Subscribe to all events. */
  onAny(handler: EventHandler): () => void {
    this.wildcardHandlers.add(handler);
    return () => this.wildcardHandlers.delete(handler);
  }

  /** Unsubscribe from a specific event type. */
  off(type: TraceEventType, handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  /** Subscribe to a specific event type for one emission only. */
  once(type: TraceEventType, handler: EventHandler): () => void {
    const wrapper: EventHandler = (event) => {
      this.off(type, wrapper);
      handler(event);
    };
    return this.on(type, wrapper);
  }

  /** Emit a trace event. */
  emit(event: TraceEvent): void {
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try { handler(event); } catch { /* fault isolation */ }
      }
    }
    for (const handler of this.wildcardHandlers) {
      try { handler(event); } catch { /* fault isolation */ }
    }
  }

  /** Remove all handlers. */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }

  /** Get the count of handlers for a type (or all if no type). */
  listenerCount(type?: TraceEventType): number {
    if (type) {
      return (this.handlers.get(type)?.size ?? 0) + this.wildcardHandlers.size;
    }
    let total = this.wildcardHandlers.size;
    for (const handlers of this.handlers.values()) {
      total += handlers.size;
    }
    return total;
  }
}
