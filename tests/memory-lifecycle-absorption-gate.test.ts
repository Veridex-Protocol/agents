import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '../src/memory/InMemoryStore';
import { MemoryLifecycle } from '../src/memory/MemoryLifecycle';
import {
  AllowAllAbsorptionGate,
  DenyAllAbsorptionGate,
  LLMAbsorptionGate,
  ApprovalAbsorptionGate,
  CompositeAbsorptionGate,
  type AbsorptionGate,
  type AbsorptionDecision,
} from '../src/memory/AbsorptionGate';
import { ApprovalManager } from '../src/approvals/ApprovalManager';
import type { MemoryEntry } from '../src/types/memory';

async function seedEpisodic(
  store: InMemoryStore,
  content: string,
  confidence = 0.9,
): Promise<MemoryEntry> {
  return store.write({
    overwriteStrategy: 'append',
    entry: {
      tier: 'episodic',
      content,
      provenance: 'agent',
      confidence,
      scope: 'agent',
      ttlMs: 0,
      tags: [],
    },
  });
}

describe('AbsorptionGate — promotion gating', () => {
  it('AllowAllAbsorptionGate promotes every eligible candidate', async () => {
    const store = new InMemoryStore();
    const a = await seedEpisodic(store, 'fact-a');
    const b = await seedEpisodic(store, 'fact-b');
    // Age past the minimum.
    await new Promise((r) => setTimeout(r, 10));

    const res = await new MemoryLifecycle({
      store,
      promote: {
        minConfidence: 0.5,
        minAgeMs: 0,
        gate: new AllowAllAbsorptionGate(),
      },
    }).promote();

    expect(res.promoted).toBe(2);
    expect(res.denied).toBe(0);
    expect(res.escalated).toBe(0);
    expect(res.decisions).toHaveLength(2);
    expect((await store.read(a.id))!.tier).toBe('semantic');
    expect((await store.read(b.id))!.tier).toBe('semantic');
  });

  it('DenyAllAbsorptionGate keeps entries episodic and decays confidence', async () => {
    const store = new InMemoryStore();
    const a = await seedEpisodic(store, 'noise', 0.9);

    const res = await new MemoryLifecycle({
      store,
      promote: {
        minConfidence: 0.5,
        minAgeMs: 0,
        gate: new DenyAllAbsorptionGate(),
        denyConfidenceDecay: 0.5,
      },
    }).promote();

    expect(res.promoted).toBe(0);
    expect(res.denied).toBe(1);
    const after = (await store.read(a.id))!;
    expect(after.tier).toBe('episodic');
    expect(after.confidence).toBeCloseTo(0.45, 5);
  });

  it('LLMAbsorptionGate maps scores to allow/deny/escalate via thresholds', async () => {
    const store = new InMemoryStore();
    const high = await seedEpisodic(store, 'high-score');
    const mid = await seedEpisodic(store, 'mid-score');
    const low = await seedEpisodic(store, 'low-score');

    const judge = vi.fn(async (entry: MemoryEntry) => {
      if (entry.content === 'high-score') return { score: 0.9, reason: 'stable' };
      if (entry.content === 'mid-score') return { score: 0.55, reason: 'borderline' };
      return { score: 0.1, reason: 'noisy' };
    });

    const res = await new MemoryLifecycle({
      store,
      promote: {
        minConfidence: 0.5,
        minAgeMs: 0,
        gate: new LLMAbsorptionGate({
          judge,
          allowThreshold: 0.75,
          denyThreshold: 0.4,
        }),
      },
    }).promote();

    expect(judge).toHaveBeenCalledTimes(3);
    expect(res.promoted).toBe(1);
    expect(res.denied).toBe(1);
    expect(res.escalated).toBe(1);
    expect((await store.read(high.id))!.tier).toBe('semantic');
    expect((await store.read(mid.id))!.tier).toBe('episodic');
    expect((await store.read(low.id))!.tier).toBe('episodic');
  });

  it('LLMAbsorptionGate is fail-closed when the judge throws', async () => {
    const store = new InMemoryStore();
    await seedEpisodic(store, 'fact');

    const res = await new MemoryLifecycle({
      store,
      promote: {
        minConfidence: 0.5,
        minAgeMs: 0,
        gate: new LLMAbsorptionGate({
          judge: async () => {
            throw new Error('judge offline');
          },
        }),
      },
    }).promote();

    expect(res.promoted).toBe(0);
    expect(res.denied).toBe(1);
    expect(res.decisions[0]?.reason).toContain('judge offline');
  });

  it('ApprovalAbsorptionGate routes through ApprovalManager and approves on grant', async () => {
    const store = new InMemoryStore();
    const entry = await seedEpisodic(store, 'sensitive-fact');
    const approvals = new ApprovalManager();
    approvals.addRoute({
      match: () => true,
      mode: 'human_required',
    });
    approvals.registerHandler('human_required', async (req) => ({
      requestId: req.id,
      approved: true,
      decidedBy: 'reviewer:alice',
      reason: 'looks good',
      decidedAt: Date.now(),
    }));

    const gate = new ApprovalAbsorptionGate({
      approvals,
      runId: 'run-1',
      agentId: 'agent-1',
    });

    const res = await new MemoryLifecycle({
      store,
      promote: { minConfidence: 0.5, minAgeMs: 0, gate },
    }).promote();

    expect(res.promoted).toBe(1);
    expect((await store.read(entry.id))!.tier).toBe('semantic');
  });

  it('CompositeAbsorptionGate escalates LLM borderline calls to approvals', async () => {
    const store = new InMemoryStore();
    const escalateEntry = await seedEpisodic(store, 'borderline');
    const allowEntry = await seedEpisodic(store, 'clearly-stable');

    const llm = new LLMAbsorptionGate({
      judge: async (e) =>
        e.content === 'clearly-stable'
          ? { score: 0.95, reason: 'stable' }
          : { score: 0.55, reason: 'borderline' },
      borderline: 'escalate',
    });

    const approvals = new ApprovalManager();
    approvals.addRoute({ match: () => true, mode: 'human_required' });
    let approvalCalls = 0;
    approvals.registerHandler('human_required', async (req) => {
      approvalCalls += 1;
      return {
        requestId: req.id,
        approved: false,
        decidedBy: 'reviewer:bob',
        reason: 'too speculative',
        decidedAt: Date.now(),
      };
    });
    const human = new ApprovalAbsorptionGate({
      approvals,
      runId: 'run-2',
      agentId: 'agent-2',
    });
    const composite = new CompositeAbsorptionGate({ primary: llm, escalation: human });

    const res = await new MemoryLifecycle({
      store,
      promote: { minConfidence: 0.5, minAgeMs: 0, gate: composite },
    }).promote();

    expect(approvalCalls).toBe(1);
    expect(res.promoted).toBe(1); // clearly-stable
    expect(res.denied).toBe(1); // borderline → human denied
    expect((await store.read(allowEntry.id))!.tier).toBe('semantic');
    expect((await store.read(escalateEntry.id))!.tier).toBe('episodic');
  });

  it('emits onDecision callbacks for every candidate', async () => {
    const store = new InMemoryStore();
    await seedEpisodic(store, 'a');
    await seedEpisodic(store, 'b');
    const seen: AbsorptionDecision[] = [];
    const gate: AbsorptionGate = new AllowAllAbsorptionGate();

    await new MemoryLifecycle({
      store,
      promote: {
        minConfidence: 0.5,
        minAgeMs: 0,
        gate,
        onDecision: (d) => seen.push(d),
      },
    }).promote();

    expect(seen).toHaveLength(2);
    expect(seen.every((d) => d.verdict === 'allow')).toBe(true);
  });

  it('legacy path (no gate) preserves original behaviour', async () => {
    const store = new InMemoryStore();
    const entry = await seedEpisodic(store, 'auto');

    const res = await new MemoryLifecycle({
      store,
      promote: { minConfidence: 0.5, minAgeMs: 0 },
    }).promote();

    expect(res.promoted).toBe(1);
    expect(res.decisions).toEqual([]);
    expect((await store.read(entry.id))!.tier).toBe('semantic');
  });
});
