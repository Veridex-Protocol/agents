import { describe, it, expect, beforeEach } from 'vitest';
import {
  PolicyEngine,
  blockSafetyClasses,
  requireApprovalFor,
  maxRunSpendUSD,
  maxTokenBudget,
  allowChains,
} from '../src/policy';
import type { PolicyContext, PolicyRule } from '../src/policy';
import type { ActionProposal } from '../src/types/proposals';
import type { ToolContract } from '../src/types/tools';

function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    agentId: 'agent_1',
    runId: 'run_1',
    turnIndex: 0,
    proposal: { type: 'final_answer', answer: 'test' } as ActionProposal,
    ...overrides,
  };
}

function makeToolCallContext(
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>,
  overrides: Partial<PolicyContext> = {},
): PolicyContext {
  return makeContext({
    proposal: {
      type: 'tool_call',
      toolCalls: toolCalls.map((tc, i) => ({
        id: `tc_${i}`,
        name: tc.name,
        arguments: tc.arguments ?? {},
      })),
    } as ActionProposal,
    ...overrides,
  });
}

function makeToolMap(
  tools: Array<{ name: string; safetyClass: string }>,
): Map<string, ToolContract> {
  const map = new Map<string, ToolContract>();
  for (const t of tools) {
    map.set(t.name, {
      name: t.name,
      description: `Tool: ${t.name}`,
      input: { type: 'object' },
      safetyClass: t.safetyClass,
      execute: async () => ({ llmOutput: 'ok', success: true }),
    } as unknown as ToolContract);
  }
  return map;
}

describe('PolicyEngine', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  it('returns pass with no rules', async () => {
    const decision = await engine.evaluate(makeContext());
    expect(decision.verdict).toBe('pass');
    expect(decision.riskScore).toBe(0);
    expect(decision.checks).toHaveLength(0);
  });

  it('registers and lists rules', () => {
    const rule: PolicyRule = {
      id: 'test-rule',
      name: 'Test Rule',
      description: 'A test rule',
      evaluate: () => ({
        ruleId: 'test-rule', ruleName: 'Test Rule',
        passed: true, verdict: 'pass', reason: 'ok', riskContribution: 0,
      }),
    };
    engine.register(rule);
    expect(engine.list()).toHaveLength(1);
    expect(engine.list()[0].id).toBe('test-rule');
  });

  it('removes a rule by id', () => {
    engine.register({
      id: 'r1', name: 'R1', description: 'R1',
      evaluate: () => ({
        ruleId: 'r1', ruleName: 'R1',
        passed: true, verdict: 'pass', reason: '', riskContribution: 0,
      }),
    });
    expect(engine.remove('r1')).toBe(true);
    expect(engine.list()).toHaveLength(0);
  });

  it('clears all rules', () => {
    engine.register({
      id: 'r1', name: 'R1', description: 'R1',
      evaluate: () => ({
        ruleId: 'r1', ruleName: 'R1',
        passed: true, verdict: 'pass', reason: '', riskContribution: 0,
      }),
    });
    engine.register({
      id: 'r2', name: 'R2', description: 'R2',
      evaluate: () => ({
        ruleId: 'r2', ruleName: 'R2',
        passed: true, verdict: 'pass', reason: '', riskContribution: 0,
      }),
    });
    engine.clear();
    expect(engine.list()).toHaveLength(0);
  });

  it('uses highest severity verdict', async () => {
    engine.register({
      id: 'flag-rule', name: 'Flag', description: 'flag',
      evaluate: () => ({
        ruleId: 'flag-rule', ruleName: 'Flag',
        passed: false, verdict: 'flag', reason: 'flagged', riskContribution: 0.2,
      }),
    });
    engine.register({
      id: 'escalate-rule', name: 'Escalate', description: 'escalate',
      evaluate: () => ({
        ruleId: 'escalate-rule', ruleName: 'Escalate',
        passed: false, verdict: 'escalate', reason: 'needs review', riskContribution: 0.4,
      }),
    });

    const decision = await engine.evaluate(makeContext());
    expect(decision.verdict).toBe('escalate');
    expect(decision.checks).toHaveLength(2);
  });

  it('short-circuits on block', async () => {
    let secondRuleCalled = false;
    engine.register({
      id: 'block-rule', name: 'Block', description: 'block',
      evaluate: () => ({
        ruleId: 'block-rule', ruleName: 'Block',
        passed: false, verdict: 'block', reason: 'blocked', riskContribution: 1.0,
      }),
    });
    engine.register({
      id: 'after-block', name: 'After', description: 'after',
      evaluate: () => {
        secondRuleCalled = true;
        return {
          ruleId: 'after-block', ruleName: 'After',
          passed: true, verdict: 'pass', reason: '', riskContribution: 0,
        };
      },
    });

    const decision = await engine.evaluate(makeContext());
    expect(decision.verdict).toBe('block');
    expect(secondRuleCalled).toBe(false);
  });

  it('handles rule evaluation errors gracefully', async () => {
    engine.register({
      id: 'error-rule', name: 'Bad Rule', description: 'bad',
      evaluate: () => { throw new Error('rule crashed'); },
    });

    const decision = await engine.evaluate(makeContext());
    expect(decision.verdict).toBe('flag');
    expect(decision.checks[0].verdict).toBe('flag');
    expect(decision.checks[0].reason).toContain('rule crashed');
  });
});

describe('Built-in rules', () => {
  it('blockSafetyClasses blocks dangerous tool calls', async () => {
    const engine = new PolicyEngine();
    const tools = makeToolMap([{ name: 'transfer', safetyClass: 'financial' }]);
    engine.register(blockSafetyClasses(['financial'], tools));

    const decision = await engine.evaluate(makeToolCallContext([{ name: 'transfer' }]));
    expect(decision.verdict).toBe('block');
  });

  it('blockSafetyClasses passes safe calls', async () => {
    const engine = new PolicyEngine();
    const tools = makeToolMap([{ name: 'read_data', safetyClass: 'read' }]);
    engine.register(blockSafetyClasses(['financial'], tools));

    const decision = await engine.evaluate(makeToolCallContext([{ name: 'read_data' }]));
    expect(decision.verdict).toBe('pass');
  });

  it('requireApprovalFor escalates matching tool calls', async () => {
    const engine = new PolicyEngine();
    const tools = makeToolMap([{ name: 'transfer', safetyClass: 'financial' }]);
    engine.register(requireApprovalFor(['financial'], tools));

    const decision = await engine.evaluate(makeToolCallContext([{ name: 'transfer' }]));
    expect(decision.verdict).toBe('escalate');
  });

  it('maxRunSpendUSD blocks when budget exceeded', async () => {
    const engine = new PolicyEngine();
    engine.register(maxRunSpendUSD(100));

    const decision = await engine.evaluate(makeContext({ runSpendUSD: 150 }));
    expect(decision.verdict).toBe('block');
  });

  it('maxRunSpendUSD passes under budget', async () => {
    const engine = new PolicyEngine();
    engine.register(maxRunSpendUSD(100));

    const decision = await engine.evaluate(makeContext({ runSpendUSD: 50 }));
    expect(decision.verdict).toBe('pass');
  });

  it('maxTokenBudget blocks when token limit exceeded', async () => {
    const engine = new PolicyEngine();
    engine.register(maxTokenBudget(1000));

    const decision = await engine.evaluate(makeContext({ totalTokens: 1500 }));
    expect(decision.verdict).toBe('block');
  });

  it('allowChains blocks unknown chains', async () => {
    const engine = new PolicyEngine();
    engine.register(allowChains(['ethereum', 'base']));

    const decision = await engine.evaluate(
      makeToolCallContext([{ name: 'swap', arguments: { chain: 'solana' } }]),
    );
    expect(decision.verdict).toBe('block');
  });

  it('allowChains passes allowed chains', async () => {
    const engine = new PolicyEngine();
    engine.register(allowChains(['ethereum', 'base']));

    const decision = await engine.evaluate(
      makeToolCallContext([{ name: 'swap', arguments: { chain: 'ethereum' } }]),
    );
    expect(decision.verdict).toBe('pass');
  });
});
