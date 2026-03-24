import { describe, it, expect, beforeEach } from 'vitest';
import { AuditEmitter, InMemoryAuditSink } from '../src/audit';
import type { TraceEvent } from '../src/types/events';
import type { ModelUsage } from '../src/types/models';

function makeEmitParams(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run_1',
    agentId: 'agent_1',
    runStartedAt: Date.now() - 1000,
    runEndedAt: Date.now(),
    finalState: 'completed',
    totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } as ModelUsage,
    totalSpendUSD: 0.02,
    turnCount: 2,
    events: [] as TraceEvent[],
    policyDecisions: [],
    approvalDecisions: [],
    toolExecutions: [
      {
        toolName: 'transfer',
        turnIndex: 0,
        success: true,
        durationMs: 150,
      },
    ],
    ...overrides,
  };
}

describe('AuditEmitter', () => {
  let emitter: AuditEmitter;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    emitter = new AuditEmitter();
    sink = new InMemoryAuditSink();
    emitter.addSink(sink);
  });

  it('emits bundles to registered sinks', async () => {
    await emitter.emit(makeEmitParams());
    expect(sink.getAll()).toHaveLength(1);
    expect(sink.getAll()[0].runId).toBe('run_1');
  });

  it('adds content hash to emitted bundles', async () => {
    await emitter.emit(makeEmitParams());
    const bundle = sink.getAll()[0];
    expect(bundle.contentHash).toBeDefined();
    expect(typeof bundle.contentHash).toBe('string');
    expect(bundle.contentHash.length).toBeGreaterThan(0);
  });

  it('assigns unique bundle IDs', async () => {
    await emitter.emit(makeEmitParams());
    await emitter.emit(makeEmitParams({ runId: 'run_2' }));
    const bundles = sink.getAll();
    expect(bundles[0].id).not.toBe(bundles[1].id);
  });

  it('emits to multiple sinks', async () => {
    const sink2 = new InMemoryAuditSink();
    emitter.addSink(sink2);

    await emitter.emit(makeEmitParams());
    expect(sink.getAll()).toHaveLength(1);
    expect(sink2.getAll()).toHaveLength(1);
  });

  it('removes sinks by ID', async () => {
    emitter.removeSink(sink.id);
    await emitter.emit(makeEmitParams());
    expect(sink.getAll()).toHaveLength(0);
  });

  it('lists sinks', () => {
    const sinks = emitter.listSinks();
    expect(sinks).toHaveLength(1);
    expect(sinks[0].id).toBe('in-memory');
  });

  it('verifies bundle integrity', async () => {
    const bundle = await emitter.emit(makeEmitParams());
    const valid = await emitter.verifyBundle(bundle);
    expect(valid).toBe(true);
  });

  it('detects tampered bundles', async () => {
    const bundle = await emitter.emit(makeEmitParams());
    const tampered = { ...bundle, finalState: 'failed' };
    const valid = await emitter.verifyBundle(tampered);
    expect(valid).toBe(false);
  });
});

describe('InMemoryAuditSink', () => {
  it('stores and queries by run ID', async () => {
    const sink = new InMemoryAuditSink();
    const emitter = new AuditEmitter();
    emitter.addSink(sink);

    await emitter.emit(makeEmitParams({ runId: 'run_1' }));
    await emitter.emit(makeEmitParams({ runId: 'run_2' }));

    expect(sink.getByRunId('run_1')).toBeDefined();
    expect(sink.getByRunId('run_1')!.runId).toBe('run_1');
  });

  it('queries by agent ID', async () => {
    const sink = new InMemoryAuditSink();
    const emitter = new AuditEmitter();
    emitter.addSink(sink);

    await emitter.emit(makeEmitParams({ agentId: 'agent_a' }));
    await emitter.emit(makeEmitParams({ agentId: 'agent_a', runId: 'run_2' }));
    await emitter.emit(makeEmitParams({ agentId: 'agent_b', runId: 'run_3' }));

    expect(sink.getByAgentId('agent_a')).toHaveLength(2);
    expect(sink.getByAgentId('agent_b')).toHaveLength(1);
  });

  it('clears all bundles', async () => {
    const sink = new InMemoryAuditSink();
    const emitter = new AuditEmitter();
    emitter.addSink(sink);

    await emitter.emit(makeEmitParams());
    sink.clear();
    expect(sink.getAll()).toHaveLength(0);
  });
});

describe('AuditEmitter export', () => {
  it('exports bundles as JSON', async () => {
    const emitter = new AuditEmitter();
    const sink = new InMemoryAuditSink();
    emitter.addSink(sink);

    await emitter.emit(makeEmitParams());
    await emitter.emit(makeEmitParams({ runId: 'run_2' }));

    const exported = emitter.exportBundles(sink.getAll(), 'json');
    const parsed = JSON.parse(exported);
    expect(parsed).toHaveLength(2);
  });

  it('exports bundles as JSONL', async () => {
    const emitter = new AuditEmitter();
    const sink = new InMemoryAuditSink();
    emitter.addSink(sink);

    await emitter.emit(makeEmitParams());
    await emitter.emit(makeEmitParams({ runId: 'run_2' }));

    const exported = emitter.exportBundles(sink.getAll(), 'jsonl');
    const lines = exported.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('exports bundles as CSV', async () => {
    const emitter = new AuditEmitter();
    const sink = new InMemoryAuditSink();
    emitter.addSink(sink);

    await emitter.emit(makeEmitParams());

    const exported = emitter.exportBundles(sink.getAll(), 'csv');
    const lines = exported.trim().split('\n');
    expect(lines).toHaveLength(2); // header + 1 data row
    expect(lines[0]).toContain('runId');
  });
});
