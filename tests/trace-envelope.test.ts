import { describe, it, expect, beforeEach } from 'vitest';
import {
  TraceEnvelopeBuilder,
  UnifiedTraceCollector,
  InMemoryEnvelopeSink,
} from '../src/audit';
import type {
  TraceEnvelopeBuildParams,
  ReasoningSnapshot,
  TraceEnvelope,
} from '../src/audit';
import type { TraceEvent } from '../src/types/events';
import type { PolicyDecision } from '../src/types/policy';

// ── Helpers ──

function makeEvent(type: string, overrides?: Record<string, unknown>): TraceEvent {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 8)}`,
    type: type as TraceEvent['type'],
    runId: 'run-1',
    agentId: 'agent-1',
    timestamp: Date.now(),
    data: {},
    ...overrides,
  } as unknown as TraceEvent;
}

function makeReasoningTrace(
  turnIndex: number,
  overrides?: Partial<ReasoningSnapshot>,
): ReasoningSnapshot {
  return {
    traceId: `trace_${turnIndex}`,
    turnIndex,
    prompt: `Turn ${turnIndex} prompt`,
    llmOutput: `Turn ${turnIndex} response`,
    toolCalls: [
      {
        tool: 'search',
        inputs: { query: 'test' },
        outputs: { results: [] },
        timestamp: Date.now(),
      },
    ],
    ...overrides,
  };
}

function makeBuildParams(
  overrides?: Partial<TraceEnvelopeBuildParams>,
): TraceEnvelopeBuildParams {
  return {
    runId: 'run-1',
    agentId: 'agent-1',
    runStartedAt: 1000,
    runEndedAt: 2000,
    finalState: 'completed',
    totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    totalSpendUSD: 0.02,
    turnCount: 2,
    events: [makeEvent('run_started'), makeEvent('run_completed')],
    reasoningTraces: [makeReasoningTrace(0), makeReasoningTrace(1)],
    policyDecisions: [],
    approvalDecisions: [],
    toolExecutions: [
      { toolName: 'search', turnIndex: 0, success: true, durationMs: 120 },
    ],
    ...overrides,
  };
}

// ── TraceEnvelopeBuilder ──

describe('TraceEnvelopeBuilder', () => {
  let builder: TraceEnvelopeBuilder;

  beforeEach(() => {
    builder = new TraceEnvelopeBuilder();
  });

  it('builds an envelope with all fields', async () => {
    const env = await builder.build(makeBuildParams());
    expect(env.version).toBe(1);
    expect(env.id).toMatch(/^env_/);
    expect(env.runId).toBe('run-1');
    expect(env.agentId).toBe('agent-1');
    expect(env.finalState).toBe('completed');
    expect(env.turnCount).toBe(2);
    expect(env.events.length).toBe(2);
    expect(env.reasoningTraces.length).toBe(2);
    expect(env.toolExecutions.length).toBe(1);
    expect(env.assembledAt).toBeGreaterThan(0);
  });

  it('computes content hash', async () => {
    const env = await builder.build(makeBuildParams());
    expect(env.contentHash).toBeTruthy();
    expect(env.contentHash.length).toBeGreaterThan(8);
  });

  it('computes envelope hash', async () => {
    const env = await builder.build(makeBuildParams());
    expect(env.envelopeHash).toBeTruthy();
    expect(env.envelopeHash).not.toBe(env.contentHash);
  });

  it('produces deterministic content hash for same input', async () => {
    const params = makeBuildParams();
    const env1 = await builder.build(params);
    const env2 = await builder.build(params);
    expect(env1.contentHash).toBe(env2.contentHash);
  });

  it('produces different hash for different content', async () => {
    const env1 = await builder.build(makeBuildParams({ finalState: 'completed' }));
    const env2 = await builder.build(makeBuildParams({ finalState: 'failed' }));
    expect(env1.contentHash).not.toBe(env2.contentHash);
  });

  it('verifies a valid envelope', async () => {
    const env = await builder.build(makeBuildParams());
    const result = await builder.verify(env);
    expect(result.contentValid).toBe(true);
    expect(result.envelopeValid).toBe(true);
  });

  it('detects content tampering', async () => {
    const env = await builder.build(makeBuildParams());
    const tampered = { ...env, finalState: 'failed' };
    const result = await builder.verify(tampered);
    expect(result.contentValid).toBe(false);
  });

  it('detects envelope tampering', async () => {
    const env = await builder.build(makeBuildParams());
    const tampered = { ...env, contentHash: 'deadbeef' };
    const result = await builder.verify(tampered);
    expect(result.envelopeValid).toBe(false);
  });

  it('verifies reasoning trace hashes', async () => {
    const trace = makeReasoningTrace(0);
    trace.traceHash = await builder.hashReasoningTrace(trace);

    const env = await builder.build(
      makeBuildParams({ reasoningTraces: [trace] }),
    );
    const result = await builder.verify(env);
    expect(result.validTraceCount).toBe(1);
    expect(result.totalTraceCount).toBe(1);
  });

  it('detects tampered reasoning trace hashes', async () => {
    const trace = makeReasoningTrace(0);
    trace.traceHash = 'invalid_hash';

    const env = await builder.build(
      makeBuildParams({ reasoningTraces: [trace] }),
    );
    const result = await builder.verify(env);
    expect(result.validTraceCount).toBe(0);
    expect(result.totalTraceCount).toBe(1);
  });

  it('skips traces without hashes during verification', async () => {
    const env = await builder.build(makeBuildParams());
    const result = await builder.verify(env);
    // reasoningTraces don't have traceHash set, so totalTraceCount = 0
    expect(result.totalTraceCount).toBe(0);
  });

  it('includes optional fields', async () => {
    const env = await builder.build(
      makeBuildParams({
        signature: 'sig_123',
        signerIdentity: '0xABC',
        storageReceipt: {
          provider: 'arweave',
          contentId: 'ar://abc',
          storedAt: Date.now(),
          immutable: true,
        },
        settlementProof: {
          txHash: '0x123',
          blockNumber: 42,
          hashInCalldata: true,
          chainId: 8453,
          explorerUrl: 'https://basescan.org/tx/0x123',
        },
        metadata: { env: 'production' },
      }),
    );
    expect(env.signature).toBe('sig_123');
    expect(env.signerIdentity).toBe('0xABC');
    expect(env.storageReceipt?.provider).toBe('arweave');
    expect(env.settlementProof?.chainId).toBe(8453);
    expect(env.metadata?.env).toBe('production');
  });

  it('accepts custom hasher', async () => {
    let hashCalls = 0;
    const customBuilder = new TraceEnvelopeBuilder({
      hasher: async (content) => {
        hashCalls++;
        return `custom_${content.length}`;
      },
    });
    const env = await customBuilder.build(makeBuildParams());
    expect(env.contentHash).toMatch(/^custom_/);
    expect(env.envelopeHash).toMatch(/^custom_/);
    expect(hashCalls).toBe(2); // content hash + envelope hash
  });

  it('hashes individual reasoning traces', async () => {
    const trace = makeReasoningTrace(0);
    const hash = await builder.hashReasoningTrace(trace);
    expect(hash).toBeTruthy();
    expect(hash.length).toBeGreaterThan(8);

    // Deterministic
    const hash2 = await builder.hashReasoningTrace(trace);
    expect(hash2).toBe(hash);
  });

  it('handles empty events and traces', async () => {
    const env = await builder.build(
      makeBuildParams({
        events: [],
        reasoningTraces: [],
        policyDecisions: [],
        approvalDecisions: [],
        toolExecutions: [],
      }),
    );
    expect(env.events.length).toBe(0);
    expect(env.reasoningTraces.length).toBe(0);
    const result = await builder.verify(env);
    expect(result.contentValid).toBe(true);
    expect(result.envelopeValid).toBe(true);
  });
});

// ── UnifiedTraceCollector ──

describe('UnifiedTraceCollector', () => {
  let collector: UnifiedTraceCollector;
  let sink: InMemoryEnvelopeSink;

  beforeEach(() => {
    sink = new InMemoryEnvelopeSink();
    collector = new UnifiedTraceCollector('run-1', 'agent-1', { sinks: [sink] });
  });

  it('collects events and flushes envelope', async () => {
    collector.addEvent(makeEvent('run_started'));
    collector.addEvent(makeEvent('tool_executed'));
    collector.addUsage({ inputTokens: 50, outputTokens: 25, totalTokens: 75 });
    collector.addSpend(0.01);

    const env = await collector.flush({
      finalState: 'completed',
      turnCount: 1,
    });

    expect(env.events.length).toBe(2);
    expect(env.totalUsage.totalTokens).toBe(75);
    expect(env.totalSpendUSD).toBe(0.01);
    expect(env.contentHash).toBeTruthy();
  });

  it('collects reasoning traces', async () => {
    collector.addReasoningTrace(makeReasoningTrace(0));
    collector.addReasoningTrace(makeReasoningTrace(1));

    const env = await collector.flush({
      finalState: 'completed',
      turnCount: 2,
    });

    expect(env.reasoningTraces.length).toBe(2);
    expect(env.reasoningTraces[0].turnIndex).toBe(0);
    expect(env.reasoningTraces[1].turnIndex).toBe(1);
  });

  it('collects policy and approval decisions', async () => {
    collector.addPolicyDecision({
      verdict: 'allow',
      riskScore: 0.1,
      reasons: [],
    } as unknown as PolicyDecision);
    collector.addApprovalDecision({
      approved: true,
      reason: 'auto',
    } as any);

    const env = await collector.flush({
      finalState: 'completed',
      turnCount: 1,
    });

    expect(env.policyDecisions.length).toBe(1);
    expect(env.approvalDecisions.length).toBe(1);
  });

  it('collects tool executions', async () => {
    collector.addToolExecution({
      toolName: 'search',
      turnIndex: 0,
      success: true,
      durationMs: 100,
    });

    const env = await collector.flush({
      finalState: 'completed',
      turnCount: 1,
    });

    expect(env.toolExecutions.length).toBe(1);
    expect(env.toolExecutions[0].toolName).toBe('search');
  });

  it('accumulates usage across multiple calls', async () => {
    collector.addUsage({ inputTokens: 50, outputTokens: 25, totalTokens: 75 });
    collector.addUsage({ inputTokens: 30, outputTokens: 15, totalTokens: 45 });
    collector.addSpend(0.01);
    collector.addSpend(0.02);

    const env = await collector.flush({
      finalState: 'completed',
      turnCount: 2,
    });

    expect(env.totalUsage.inputTokens).toBe(80);
    expect(env.totalUsage.outputTokens).toBe(40);
    expect(env.totalUsage.totalTokens).toBe(120);
    expect(env.totalSpendUSD).toBeCloseTo(0.03);
  });

  it('writes to sink on flush', async () => {
    collector.addEvent(makeEvent('run_started'));
    await collector.flush({ finalState: 'completed', turnCount: 1 });

    expect(sink.getAll().length).toBe(1);
    expect(sink.getByRunId('run-1')).toBeDefined();
    expect(sink.getByAgentId('agent-1').length).toBe(1);
  });

  it('writes to multiple sinks', async () => {
    const sink2 = new InMemoryEnvelopeSink();
    collector.addSink(sink2);
    await collector.flush({ finalState: 'completed', turnCount: 1 });

    expect(sink.getAll().length).toBe(1);
    expect(sink2.getAll().length).toBe(1);
  });

  it('handles sink errors gracefully', async () => {
    const badSink: any = {
      id: 'bad',
      write: async () => { throw new Error('sink error'); },
    };
    collector.addSink(badSink);

    // Should not throw
    const env = await collector.flush({ finalState: 'completed', turnCount: 1 });
    expect(env).toBeDefined();
    expect(sink.getAll().length).toBe(1); // good sink still works
  });

  it('removes sinks', async () => {
    expect(collector.removeSink('in-memory-envelope')).toBe(true);
    expect(collector.removeSink('nonexistent')).toBe(false);
    await collector.flush({ finalState: 'completed', turnCount: 1 });
    expect(sink.getAll().length).toBe(0); // removed before flush
  });

  it('tracks event and trace counts', () => {
    expect(collector.eventCount).toBe(0);
    expect(collector.traceCount).toBe(0);

    collector.addEvent(makeEvent('run_started'));
    collector.addReasoningTrace(makeReasoningTrace(0));

    expect(collector.eventCount).toBe(1);
    expect(collector.traceCount).toBe(1);
  });

  it('exposes builder for verification', async () => {
    const env = await collector.flush({ finalState: 'completed', turnCount: 0 });
    const result = await collector.getBuilder().verify(env);
    expect(result.contentValid).toBe(true);
    expect(result.envelopeValid).toBe(true);
  });

  it('includes signature and signer identity', async () => {
    const env = await collector.flush({
      finalState: 'completed',
      turnCount: 1,
      signature: 'sig_abc',
      signerIdentity: '0xSigner',
    });
    expect(env.signature).toBe('sig_abc');
    expect(env.signerIdentity).toBe('0xSigner');
  });

  it('includes storage receipt and settlement proof', async () => {
    const env = await collector.flush({
      finalState: 'completed',
      turnCount: 1,
      storageReceipt: {
        provider: 'filecoin',
        contentId: 'bafy123',
        storedAt: Date.now(),
        immutable: true,
      },
      settlementProof: {
        txHash: '0xdeadbeef',
        hashInCalldata: true,
        chainId: 1,
      },
    });
    expect(env.storageReceipt?.provider).toBe('filecoin');
    expect(env.settlementProof?.txHash).toBe('0xdeadbeef');
  });

  it('addEvents adds multiple events at once', () => {
    collector.addEvents([makeEvent('run_started'), makeEvent('tool_executed')]);
    expect(collector.eventCount).toBe(2);
  });
});

// ── InMemoryEnvelopeSink ──

describe('InMemoryEnvelopeSink', () => {
  it('stores and queries envelopes', async () => {
    const sink = new InMemoryEnvelopeSink();
    const builder = new TraceEnvelopeBuilder();

    const env1 = await builder.build(makeBuildParams({ runId: 'run-1', agentId: 'agent-A' }));
    const env2 = await builder.build(makeBuildParams({ runId: 'run-2', agentId: 'agent-A' }));
    const env3 = await builder.build(makeBuildParams({ runId: 'run-3', agentId: 'agent-B' }));

    await sink.write(env1);
    await sink.write(env2);
    await sink.write(env3);

    expect(sink.getAll().length).toBe(3);
    expect(sink.getByRunId('run-1')?.runId).toBe('run-1');
    expect(sink.getByRunId('run-99')).toBeUndefined();
    expect(sink.getByAgentId('agent-A').length).toBe(2);
    expect(sink.getByAgentId('agent-B').length).toBe(1);
  });

  it('clears all envelopes', async () => {
    const sink = new InMemoryEnvelopeSink();
    const builder = new TraceEnvelopeBuilder();
    await sink.write(await builder.build(makeBuildParams()));
    sink.clear();
    expect(sink.getAll().length).toBe(0);
  });
});
