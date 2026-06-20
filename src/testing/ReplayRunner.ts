/**
 * @module ReplayRunner
 * Deterministic replay and golden trace testing for agent runs.
 * Enables regression testing, trace comparison, and debug replay.
 */

import type { ModelMessage, ModelResponse, } from '../types/models';
import type { TraceEvent } from '../types/events';
import type { RunResult } from '../types/runtime';

// ── Replay Types ──

/** A recorded model interaction for replay. */
export interface RecordedInteraction {
  /** Turn index. */
  turnIndex: number;
  /** Messages sent to model. */
  messages: ModelMessage[];
  /** Model response received. */
  response: ModelResponse;
}

/** A complete recorded run (golden trace). */
export interface GoldenTrace {
  /** Trace ID. */
  id: string;
  /** Agent ID. */
  agentId: string;
  /** Input that started the run. */
  input: string;
  /** Expected output. */
  expectedOutput: string;
  /** Recorded model interactions in order. */
  interactions: RecordedInteraction[];
  /** Expected events in order. */
  expectedEvents: Array<{ type: string; data?: Record<string, unknown> }>;
  /** Trace metadata. */
  metadata?: Record<string, unknown>;
  /** Creation timestamp. */
  createdAt: number;
}

/** Result of running a golden trace comparison. */
export interface TraceComparisonResult {
  /** Whether the replay matched the golden trace. */
  passed: boolean;
  /** Output from the replay run. */
  actualOutput: string;
  /** Expected output from the golden trace. */
  expectedOutput: string;
  /** Output match result. */
  outputMatch: boolean;
  /** Event comparison results. */
  eventDiffs: EventDiff[];
  /** Timing comparison. */
  timing: { recordedMs: number; replayMs: number };
}

/** A difference between expected and actual events. */
export interface EventDiff {
  index: number;
  expected: { type: string; data?: Record<string, unknown> } | null;
  actual: { type: string; data?: Record<string, unknown> } | null;
  match: boolean;
  reason?: string;
}

// ── Mock Provider ──

/**
 * A mock model provider that replays recorded interactions.
 * Used for deterministic replay testing.
 */
export class ReplayProvider {
  readonly name: string;
  private interactions: RecordedInteraction[];
  private callIndex = 0;

  constructor(name: string, interactions: RecordedInteraction[]) {
    this.name = name;
    this.interactions = interactions;
  }

  async complete(_messages: ModelMessage[]): Promise<ModelResponse> {
    const interaction = this.interactions[this.callIndex];
    if (!interaction) {
      throw new Error(
        `ReplayProvider: No more recorded interactions. Call index: ${this.callIndex}, recorded: ${this.interactions.length}`,
      );
    }
    this.callIndex++;
    return interaction.response;
  }

  /** Reset the replay to the beginning. */
  reset(): void {
    this.callIndex = 0;
  }

  /** Get the number of calls made so far. */
  getCallCount(): number {
    return this.callIndex;
  }
}

// ── Trace Recorder ──

/**
 * Records model interactions during a live run for later replay.
 */
export class TraceRecorder {
  private interactions: RecordedInteraction[] = [];
  private events: TraceEvent[] = [];

  /** Record a model interaction. */
  recordInteraction(turnIndex: number, messages: ModelMessage[], response: ModelResponse): void {
    this.interactions.push({ turnIndex, messages, response });
  }

  /** Record a trace event. */
  recordEvent(event: TraceEvent): void {
    this.events.push(event);
  }

  /** Build a golden trace from the recorded data. */
  buildGoldenTrace(
    id: string,
    agentId: string,
    input: string,
    output: string,
    metadata?: Record<string, unknown>,
  ): GoldenTrace {
    return {
      id,
      agentId,
      input,
      expectedOutput: output,
      interactions: [...this.interactions],
      expectedEvents: this.events.map((e) => ({
        type: e.type,
        data: 'data' in e ? (e as unknown as Record<string, unknown>).data as Record<string, unknown> : undefined,
      })),
      metadata,
      createdAt: Date.now(),
    };
  }

  /** Get all recorded interactions. */
  getInteractions(): RecordedInteraction[] {
    return [...this.interactions];
  }

  /** Get all recorded events. */
  getEvents(): TraceEvent[] {
    return [...this.events];
  }

  /** Reset the recorder. */
  reset(): void {
    this.interactions = [];
    this.events = [];
  }
}

// ── Trace Comparator ──

/**
 * Compares an actual run result against a golden trace.
 */
export function compareTraces(
  golden: GoldenTrace,
  actual: RunResult,
  options?: { ignoreEventOrder?: boolean; fuzzyOutputMatch?: boolean },
): TraceComparisonResult {
  const outputMatch = options?.fuzzyOutputMatch
    ? actual.output.toLowerCase().includes(golden.expectedOutput.toLowerCase())
    : actual.output === golden.expectedOutput;

  const eventDiffs: EventDiff[] = [];
  const maxLen = Math.max(golden.expectedEvents.length, actual.events.length);

  for (let i = 0; i < maxLen; i++) {
    const expected = golden.expectedEvents[i] ?? null;
    const actualEvent = actual.events[i] ?? null;

    if (!expected && actualEvent) {
      eventDiffs.push({
        index: i,
        expected: null,
        actual: { type: actualEvent.type },
        match: false,
        reason: 'Extra event in actual',
      });
    } else if (expected && !actualEvent) {
      eventDiffs.push({
        index: i,
        expected,
        actual: null,
        match: false,
        reason: 'Missing event in actual',
      });
    } else if (expected && actualEvent) {
      const typeMatch = expected.type === actualEvent.type;
      eventDiffs.push({
        index: i,
        expected,
        actual: { type: actualEvent.type },
        match: typeMatch,
        reason: typeMatch ? undefined : `Type mismatch: expected '${expected.type}', got '${actualEvent.type}'`,
      });
    }
  }

  return {
    passed: outputMatch && eventDiffs.every((d) => d.match),
    actualOutput: actual.output,
    expectedOutput: golden.expectedOutput,
    outputMatch,
    eventDiffs,
    timing: { recordedMs: 0, replayMs: 0 },
  };
}

/**
 * Serialize a golden trace to JSON for storage.
 */
export function serializeGoldenTrace(trace: GoldenTrace): string {
  return JSON.stringify(trace, null, 2);
}

/**
 * Deserialize a golden trace from JSON.
 */
export function deserializeGoldenTrace(json: string): GoldenTrace {
  return JSON.parse(json) as GoldenTrace;
}
