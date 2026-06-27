/**
 * Live integration tests against a real Gemini model.
 *
 * These validate the runtime under *real model latency* — the eval's
 * "not assessed" caveat: end-to-end correctness, checkpoint/recovery, and
 * concurrent-run state isolation (race safety).
 *
 * They are SKIPPED unless an API key is present, so normal CI is unaffected:
 *   GEMINI_API_KEY=...  (or GOOGLE_API_KEY=...)  bun run test
 * Optionally override the model:
 *   GEMINI_MODEL=gemini-3.5-flash
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentRuntime } from '../src/runtime/AgentRuntime';
import { GeminiProvider } from '../src/models/GeminiProvider';
import { tool } from '../src/tools/tool';
import { InMemoryCheckpointStore } from '../src/checkpoints/CheckpointManager';
import type { AgentDefinition } from '../src/types/agent';
import type { PolicyRule } from '../src/policy';

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash';
const live = apiKey ? describe : describe.skip;

function makeDefinition(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'gemini-agent',
    name: 'Gemini Agent',
    model: { provider: 'gemini', model: MODEL },
    instructions: 'You are a terse test assistant. Follow instructions exactly.',
    ...overrides,
  } as AgentDefinition;
}

function geminiRuntime(
  defOverrides?: Partial<AgentDefinition>,
  options?: ConstructorParameters<typeof AgentRuntime>[1],
): AgentRuntime {
  const provider = new GeminiProvider({ apiKey, model: MODEL });
  return new AgentRuntime(makeDefinition(defOverrides), {
    modelProviders: { gemini: provider },
    ...options,
  });
}

live('AgentRuntime × Gemini (live)', () => {
  it('completes a simple run under real latency', async () => {
    const runtime = geminiRuntime();
    const result = await runtime.run('Reply with exactly one word: pong');

    expect(result.run.state).toBe('completed');
    expect(result.output.trim().length).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  }, 60_000);

  it('checkpoints on approval and resumes to execute the approved tool', async () => {
    const checkpointStore = new InMemoryCheckpointStore();
    const executed: number[] = [];
    const transfer = tool({
      name: 'transferFunds',
      description: 'Move treasury funds to the company account.',
      input: z.object({ amount: z.number() }),
      safetyClass: 'financial',
      async execute({ input }) {
        executed.push(input.amount);
        return { llmOutput: `Transferred ${input.amount}`, success: true };
      },
    });

    // Deterministic regardless of the model's wording: every tool call escalates.
    const escalate: PolicyRule = {
      id: 'approval-required',
      name: 'Approval required',
      description: 'Escalate all tool calls',
      evaluate: async () => ({
        ruleId: 'approval-required',
        ruleName: 'Approval required',
        passed: false,
        verdict: 'escalate',
        reason: 'Treasury movement needs approval',
        riskContribution: 0.9,
      }),
    };

    const runtime = geminiRuntime(
      {
        tools: [transfer],
        instructions:
          'You MUST call the transferFunds tool with amount 100. Do not reply with text before calling the tool.',
      },
      { policyRules: [escalate], enableCheckpoints: true, checkpointStore },
    );

    const paused = await runtime.run('Transfer 100 to the treasury.');
    expect(paused.run.state).toBe('waiting_for_approval');
    expect(executed).toHaveLength(0); // not executed before approval

    const checkpoints = await runtime.listCheckpoints(paused.run.id);
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);

    const resumed = await runtime.resumeFromCheckpoint(checkpoints[0].id, {
      approval: { approved: true, approver: 'test-suite' },
    });

    // After approval the tool runs; the run advances past the approval gate.
    expect(resumed.run.state).not.toBe('waiting_for_approval');
    expect(executed).toEqual([100]);
  }, 90_000);

  it('runs many concurrent runs on one runtime with isolated state (race check)', async () => {
    const runtime = geminiRuntime({
      instructions: 'Reply with ONLY the single integer the user gives you, nothing else.',
    });

    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runtime.run(`Reply with only this integer: ${i}`),
      ),
    );

    // Distinct runs, all completed, no usage/state bleed between them.
    const ids = new Set(results.map((r) => r.run.id));
    expect(ids.size).toBe(N);
    for (const r of results) {
      expect(r.run.state).toBe('completed');
      expect(r.usage.totalTokens).toBeGreaterThan(0);
    }

    // Each run's output should reflect its OWN input — the core isolation check.
    const matched = results.filter((r, i) => r.output.includes(String(i))).length;
    expect(matched).toBeGreaterThanOrEqual(N - 1); // allow at most one model formatting miss
  }, 120_000);
});
