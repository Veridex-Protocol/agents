/**
 * @packageDocumentation
 * @module Streaming
 * @description
 * Streaming utilities for the Veridex Agent Runtime.
 * Provides SSE serialization and ReadableStream adapters.
 */

import type { TraceEvent } from '../types/events';

/**
 * Serialize a TraceEvent as a Server-Sent Events (SSE) message.
 * Format: `event: <type>\ndata: <json>\n\n`
 */
export function eventToSSE(event: TraceEvent): string {
  const data = JSON.stringify({
    id: event.id,
    type: event.type,
    runId: event.runId,
    agentId: event.agentId,
    turnIndex: event.turnIndex,
    timestamp: event.timestamp,
    data: (event as TraceEvent & { data?: unknown }).data,
  });
  return `event: ${event.type}\ndata: ${data}\n\n`;
}

/**
 * Convert an AsyncIterable of TraceEvents into a ReadableStream of SSE-encoded strings.
 * Suitable for HTTP response streaming.
 *
 * ```ts
 * // Express/Hono handler:
 * app.get('/stream', (c) => {
 *   const stream = streamToSSE(runtime.streamRun(input));
 *   return new Response(stream, {
 *     headers: {
 *       'Content-Type': 'text/event-stream',
 *       'Cache-Control': 'no-cache',
 *       'Connection': 'keep-alive',
 *     },
 *   });
 * });
 * ```
 */
export function streamToSSE(
  events: AsyncIterable<TraceEvent>,
): ReadableStream<string> {
  const _encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(eventToSSE(event) as unknown as string);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Filter an async event stream to only yield token_streamed events,
 * extracting just the token text. Useful for simple text streaming.
 *
 * ```ts
 * for await (const token of streamTokens(runtime.streamRun(input))) {
 *   process.stdout.write(token);
 * }
 * ```
 */
export async function* streamTokens(
  events: AsyncIterable<TraceEvent>,
): AsyncGenerator<string, void, undefined> {
  for await (const event of events) {
    if (event.type === 'token_streamed') {
      yield event.data.token;
    }
  }
}
