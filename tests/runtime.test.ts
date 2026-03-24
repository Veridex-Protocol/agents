import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { AgentRuntime } from '../src/runtime/AgentRuntime';
import { createAgent } from '../src/runtime/createAgent';
import { tool } from '../src/tools/tool';
import { InMemoryStore } from '../src/memory/InMemoryStore';
import { InMemoryCheckpointStore } from '../src/checkpoints/CheckpointManager';
import type { ModelProvider, ModelResponse, ModelMessage, ModelCompletionOptions } from '../src/types/models';
import type { AgentDefinition } from '../src/types/agent';
import type { TraceEvent, RunStartedEvent, RunCompletedEvent } from '../src/types/events';
import type { PolicyRule } from '../src/policy';

/** Create a mock model provider that returns configured responses. */
function mockProvider(responses: ModelResponse[]): ModelProvider {
  let callIndex = 0;
  return {
    name: 'mock',
    complete: vi.fn(async (_messages: ModelMessage[], _options?: ModelCompletionOptions) => {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return response;
    }),
  };
}

function makeResponse(content: string, overrides?: Partial<ModelResponse>): ModelResponse {
  return {
    content,
    model: 'mock-model',
    provider: 'mock',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
    ...overrides,
  };
}

function makeToolCallResponse(toolCalls: Array<{ name: string; args: Record<string, unknown> }>): ModelResponse {
  return {
    content: '',
    model: 'mock-model',
    provider: 'mock',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    finishReason: 'tool_calls',
    toolCalls: toolCalls.map((tc, i) => ({
      id: `tc_${i}`,
      name: tc.name,
      arguments: JSON.stringify(tc.args),
    })),
  };
}

function makeDefinition(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    model: { provider: 'mock', model: 'mock-model' },
    instructions: 'You are a test assistant.',
    ...overrides,
  };
}

describe('AgentRuntime', () => {
  describe('basic run cycle', () => {
    it('completes a simple run with final answer', async () => {
      const provider = mockProvider([makeResponse('Hello!')]);
      const runtime = new AgentRuntime(makeDefinition(), {
        modelProviders: { mock: provider },
      });

      const result = await runtime.run('Say hello');

      expect(result.output).toBe('Hello!');
      expect(result.run.state).toBe('completed');
      expect(result.run.turns).toHaveLength(1);
      expect(result.usage.totalTokens).toBe(30);
    });

    it('executes tool calls and continues', async () => {
      const greetTool = tool({
        name: 'greet',
        description: 'Greet a user',
        input: z.object({ name: z.string() }),
        safetyClass: 'read',
        async execute({ input }) {
          return { llmOutput: `Hello, ${input.name}!`, success: true };
        },
      });

      const provider = mockProvider([
        makeToolCallResponse([{ name: 'greet', args: { name: 'Alice' } }]),
        makeResponse('I greeted Alice for you!'),
      ]);

      const runtime = new AgentRuntime(makeDefinition({ tools: [greetTool] }), {
        modelProviders: { mock: provider },
      });

      const result = await runtime.run('Say hi to Alice');

      expect(result.output).toBe('I greeted Alice for you!');
      expect(result.run.turns).toHaveLength(2);
      expect(result.run.turns[0].proposal.type).toBe('tool_call');
      expect(result.run.turns[1].proposal.type).toBe('final_answer');
    });

    it('respects maxTurns limit', async () => {
      const provider = mockProvider([
        makeToolCallResponse([{ name: 'greet', args: { name: 'test' } }]),
      ]);

      const greetTool = tool({
        name: 'greet',
        description: 'test',
        input: z.object({ name: z.string() }),
        safetyClass: 'read',
        execute: async () => ({ llmOutput: 'ok', success: true }),
      });

      const runtime = new AgentRuntime(makeDefinition({ maxTurns: 3, tools: [greetTool] }), {
        modelProviders: { mock: provider },
      });

      const result = await runtime.run('Loop forever');

      expect(result.run.turns).toHaveLength(3);
      expect(result.run.state).toBe('completed');
    });

    it('enforces token budget', async () => {
      const provider = mockProvider([
        makeResponse('ok', { usage: { inputTokens: 500, outputTokens: 600, totalTokens: 1100 } }),
      ]);

      const runtime = new AgentRuntime(makeDefinition({ maxTokens: 100 }), {
        modelProviders: { mock: provider },
      });

      const result = await runtime.run('test');

      expect(result.run.state).toBe('failed');
      expect(result.run.error).toContain('Token budget exceeded');
    });
  });

  describe('event tracing', () => {
    it('emits run_started and run_completed events', async () => {
      const provider = mockProvider([makeResponse('done')]);
      const events: TraceEvent[] = [];
      const runtime = new AgentRuntime(makeDefinition(), {
        modelProviders: { mock: provider },
        onEvent: (e) => events.push(e as TraceEvent),
      });

      await runtime.run('test');

      const types = events.map((e) => e.type);
      expect(types).toContain('run_started');
      expect(types).toContain('run_completed');
      expect(types).toContain('model_call_started');
      expect(types).toContain('model_call_completed');
    });

    it('run_started event has data wrapper', async () => {
      const provider = mockProvider([makeResponse('done')]);
      const events: TraceEvent[] = [];
      const runtime = new AgentRuntime(makeDefinition(), {
        modelProviders: { mock: provider },
        onEvent: (e) => events.push(e as TraceEvent),
      });

      await runtime.run('hello world');

      const started = events.find((e) => e.type === 'run_started') as RunStartedEvent;
      expect(started).toBeDefined();
      expect(started.data.input).toBe('hello world');
    });

    it('run_completed event has data wrapper with state and usage', async () => {
      const provider = mockProvider([makeResponse('done')]);
      const events: TraceEvent[] = [];
      const runtime = new AgentRuntime(makeDefinition(), {
        modelProviders: { mock: provider },
        onEvent: (e) => events.push(e as TraceEvent),
      });

      await runtime.run('test');

      const completed = events.find((e) => e.type === 'run_completed') as RunCompletedEvent;
      expect(completed).toBeDefined();
      expect(completed.data.output).toBe('done');
      expect(completed.data.state).toBe('completed');
      expect(completed.data.turnCount).toBe(1);
      expect(completed.data.totalUsage.totalTokens).toBe(30);
    });

    it('emits tool_executed events on tool calls', async () => {
      const greetTool = tool({
        name: 'greet',
        description: 'test',
        input: z.object({ name: z.string() }),
        safetyClass: 'read',
        execute: async () => ({ llmOutput: 'hi', success: true }),
      });

      const provider = mockProvider([
        makeToolCallResponse([{ name: 'greet', args: { name: 'test' } }]),
        makeResponse('done'),
      ]);

      const events: TraceEvent[] = [];
      const runtime = new AgentRuntime(makeDefinition({ tools: [greetTool] }), {
        modelProviders: { mock: provider },
        onEvent: (e) => events.push(e as TraceEvent),
      });

      await runtime.run('test');

      const toolEvent = events.find((e) => e.type === 'tool_executed');
      expect(toolEvent).toBeDefined();
      expect((toolEvent as any).data.toolName).toBe('greet');
      expect((toolEvent as any).data.success).toBe(true);
    });

    it('emits context_compiled events with bounded runtime context', async () => {
      const memoryStore = new InMemoryStore();
      await memoryStore.write({
        entry: {
          tier: 'semantic',
          content: 'The customer is Acme Corp.',
          provenance: 'system',
          confidence: 0.9,
          scope: 'agent',
          ttlMs: 0,
          tags: ['crm'],
        },
        overwriteStrategy: 'skip',
      });

      const searchTool = tool({
        name: 'searchDocs',
        description: 'Search internal documents',
        input: z.object({ query: z.string() }),
        safetyClass: 'read',
        execute: async () => ({ llmOutput: 'found', success: true }),
      });

      const provider = mockProvider([makeResponse('done')]);
      const runtime = new AgentRuntime(makeDefinition({ tools: [searchTool] }), {
        modelProviders: { mock: provider },
        memoryStore,
      });

      await runtime.run('What do we know about Acme?', { tenant: 'acme' });

      const firstCallMessages = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as ModelMessage[];
      const systemContext = firstCallMessages.find(
        (message, index) => message.role === 'system' && index > 0,
      );
      expect(systemContext?.content).toContain('Runtime context:');
      expect(systemContext?.content).toContain('The customer is Acme Corp.');
      expect(systemContext?.content).toContain('searchDocs');

      const contextEvent = runtime.eventLog.getByRun(runtime.eventLog.getAll()[0].runId)
        .find((event) => event.type === 'context_compiled');
      expect(contextEvent).toBeDefined();
    });

    it('records events in eventLog', async () => {
      const provider = mockProvider([makeResponse('done')]);
      const runtime = new AgentRuntime(makeDefinition(), {
        modelProviders: { mock: provider },
      });

      const result = await runtime.run('test');

      expect(result.events.length).toBeGreaterThan(0);
      expect(runtime.eventLog.size).toBeGreaterThan(0);
    });

    it('disables tracing when enableTracing=false', async () => {
      const provider = mockProvider([makeResponse('done')]);
      const events: TraceEvent[] = [];
      const runtime = new AgentRuntime(makeDefinition(), {
        modelProviders: { mock: provider },
        enableTracing: false,
        onEvent: (e) => events.push(e as TraceEvent),
      });

      await runtime.run('test');

      expect(events).toHaveLength(0);
      expect(runtime.eventLog.size).toBe(0);
    });
  });

  describe('hooks', () => {
    it('beforeRun hook can deny a run', async () => {
      const provider = mockProvider([makeResponse('should not reach')]);
      const runtime = new AgentRuntime(
        makeDefinition({
          hooks: {
            beforeRun: [{
              name: 'block_run',
              phase: 'beforeRun',
              execute: async () => ({
                override: 'deny' as const,
                reason: 'testing',
              }),
            }],
          },
        }),
        { modelProviders: { mock: provider } },
      );

      const result = await runtime.run('test');

      expect(result.run.state).toBe('failed');
      expect(result.run.error).toContain('denied by hook');
      expect(provider.complete).not.toHaveBeenCalled();
    });

    it('beforeTurn hook can deny a turn', async () => {
      const provider = mockProvider([makeResponse('should not reach')]);
      const runtime = new AgentRuntime(
        makeDefinition({
          hooks: {
            beforeTurn: [{
              name: 'block_turn',
              phase: 'beforeTurn',
              execute: async () => ({
                override: 'deny' as const,
                reason: 'turn blocked',
              }),
            }],
          },
        }),
        { modelProviders: { mock: provider } },
      );

      const result = await runtime.run('test');

      expect(result.run.state).toBe('failed');
      expect(result.run.error).toContain('Turn 0 denied');
    });
  });

  describe('durable approvals', () => {
    it('suspends a run and checkpoints when approval is required', async () => {
      const checkpointStore = new InMemoryCheckpointStore();
      const transfer = tool({
        name: 'transferFunds',
        description: 'Move treasury funds',
        input: z.object({ amount: z.number() }),
        safetyClass: 'financial',
        execute: async ({ input }) => ({
          llmOutput: `Transferred ${input.amount}`,
          success: true,
          metrics: { costUSD: input.amount },
        }),
      });

      const approvalRule: PolicyRule = {
        id: 'approval-required',
        name: 'Approval required',
        description: 'Escalate all tool calls',
        evaluate: async () => ({
          ruleId: 'approval-required',
          ruleName: 'Approval required',
          passed: false,
          verdict: 'escalate',
          reason: 'Needs approval',
          riskContribution: 0.9,
        }),
      };

      const provider = mockProvider([
        makeToolCallResponse([{ name: 'transferFunds', args: { amount: 5 } }]),
      ]);

      const runtime = new AgentRuntime(makeDefinition({ tools: [transfer] }), {
        modelProviders: { mock: provider },
        policyRules: [approvalRule],
        enableCheckpoints: true,
        checkpointStore,
      });

      const result = await runtime.run('Move $5');

      expect(result.run.state).toBe('waiting_for_approval');
      expect(result.run.turns).toHaveLength(1);
      expect(await runtime.listCheckpoints(result.run.id)).toHaveLength(1);
      expect(result.events.some((event) => event.type === 'approval_requested')).toBe(true);
    });

    it('resumes from a checkpoint and executes the approved tool call', async () => {
      const checkpointStore = new InMemoryCheckpointStore();
      const transfer = tool({
        name: 'transferFunds',
        description: 'Move treasury funds',
        input: z.object({ amount: z.number() }),
        safetyClass: 'financial',
        execute: async ({ input }) => ({
          llmOutput: `Transferred ${input.amount}`,
          success: true,
          metrics: { costUSD: input.amount },
        }),
      });

      const approvalRule: PolicyRule = {
        id: 'approval-required',
        name: 'Approval required',
        description: 'Escalate all tool calls',
        evaluate: async () => ({
          ruleId: 'approval-required',
          ruleName: 'Approval required',
          passed: false,
          verdict: 'escalate',
          reason: 'Needs approval',
          riskContribution: 0.9,
        }),
      };

      const provider = mockProvider([
        makeToolCallResponse([{ name: 'transferFunds', args: { amount: 5 } }]),
        makeResponse('Transfer completed and logged.'),
      ]);

      const runtime = new AgentRuntime(makeDefinition({ tools: [transfer] }), {
        modelProviders: { mock: provider },
        policyRules: [approvalRule],
        enableCheckpoints: true,
        checkpointStore,
      });

      const suspended = await runtime.run('Move $5');
      const checkpoint = (await runtime.listCheckpoints(suspended.run.id))[0];

      const resumed = await runtime.resumeFromCheckpoint(checkpoint.id, {
        approval: {
          approved: true,
          approver: 'finance-team',
          requestId: (suspended.run.turns[0].result as { requestId?: string }).requestId,
        },
      });

      expect(resumed.run.state).toBe('completed');
      expect(resumed.output).toBe('Transfer completed and logged.');
      expect(Array.isArray(resumed.run.turns[0].result)).toBe(true);
      expect(runtime.getLatestContextPlan(resumed.run.id)).toBeTruthy();
    });
  });

  describe('live handoffs', () => {
    it('completes a run through a registered handoff handler', async () => {
      const provider = mockProvider([
        makeResponse('', {
          finishReason: 'stop',
          content: JSON.stringify({
            type: 'handoff',
            targetAgentId: 'external-support',
            reason: 'Need billing support',
            context: 'Customer asked for a refund.',
          }),
        }),
      ]);

      const runtime = new AgentRuntime(makeDefinition(), {
        modelProviders: { mock: provider },
        handoffHandlers: {
          'external-support': async ({ reason, context }) => ({
            success: true,
            output: `${reason}: ${context}`,
          }),
        },
      });

      const result = await runtime.run('Help this customer');

      expect(result.run.state).toBe('completed');
      expect(result.output).toBe('Need billing support: Customer asked for a refund.');
      expect(result.events.some((event) => event.type === 'handoff_initiated')).toBe(true);
    });
  });

  describe('error handling', () => {
    it('handles model provider errors gracefully', async () => {
      const provider: ModelProvider = {
        name: 'mock',
        complete: vi.fn(async () => {
          throw new Error('API rate limit exceeded');
        }),
      };

      const runtime = new AgentRuntime(makeDefinition(), {
        modelProviders: { mock: provider },
      });

      const result = await runtime.run('test');

      expect(result.run.state).toBe('failed');
      expect(result.run.error).toContain('API rate limit exceeded');
    });

    it('throws when model provider is not registered', async () => {
      const runtime = new AgentRuntime(makeDefinition());

      const result = await runtime.run('test');

      expect(result.run.state).toBe('failed');
      expect(result.run.error).toContain('not registered');
    });
  });

  describe('proposals', () => {
    it('parses tool_call proposals correctly', async () => {
      const greetTool = tool({
        name: 'greet',
        description: 'test',
        input: z.object({ name: z.string() }),
        safetyClass: 'read',
        execute: async () => ({ llmOutput: 'hi', success: true }),
      });

      const provider = mockProvider([
        makeToolCallResponse([{ name: 'greet', args: { name: 'Bob' } }]),
        makeResponse('done'),
      ]);

      const runtime = new AgentRuntime(makeDefinition({ tools: [greetTool] }), {
        modelProviders: { mock: provider },
      });

      const result = await runtime.run('test');
      const firstTurn = result.run.turns[0];

      expect(firstTurn.proposal.type).toBe('tool_call');
      if (firstTurn.proposal.type === 'tool_call') {
        expect(firstTurn.proposal.toolCalls[0].name).toBe('greet');
        expect(firstTurn.proposal.toolCalls[0].arguments).toEqual({ name: 'Bob' });
      }
    });

    it('parses final_answer proposals correctly', async () => {
      const provider = mockProvider([makeResponse('The answer is 42')]);
      const runtime = new AgentRuntime(makeDefinition(), {
        modelProviders: { mock: provider },
      });

      const result = await runtime.run('test');

      expect(result.run.turns[0].proposal.type).toBe('final_answer');
      if (result.run.turns[0].proposal.type === 'final_answer') {
        expect(result.run.turns[0].proposal.answer).toBe('The answer is 42');
      }
    });
  });

  describe('tool execution flow', () => {
    it('passes tool results back in conversation history', async () => {
      const greetTool = tool({
        name: 'greet',
        description: 'test',
        input: z.object({ name: z.string() }),
        safetyClass: 'read',
        execute: async ({ input }) => ({
          llmOutput: `Greeted ${input.name}`,
          success: true,
        }),
      });

      const provider = mockProvider([
        makeToolCallResponse([{ name: 'greet', args: { name: 'Alice' } }]),
        makeResponse('Done'),
      ]);

      const runtime = new AgentRuntime(makeDefinition({ tools: [greetTool] }), {
        modelProviders: { mock: provider },
      });

      await runtime.run('test');

      // The second call should include the tool result in messages
      const secondCallMessages = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[1][0] as ModelMessage[];

      // Should have: system, user, assistant (with tool call), tool (result)
      expect(secondCallMessages.length).toBeGreaterThanOrEqual(4);
      const toolMsg = secondCallMessages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toBe('Greeted Alice');
    });

    it('handles tool execution errors within run', async () => {
      const failTool = tool({
        name: 'fail_tool',
        description: 'always fails',
        input: z.object({}),
        safetyClass: 'read',
        execute: async () => {
          throw new Error('Tool crashed');
        },
      });

      const provider = mockProvider([
        makeToolCallResponse([{ name: 'fail_tool', args: {} }]),
        makeResponse('Tool failed, sorry'),
      ]);

      const runtime = new AgentRuntime(makeDefinition({ tools: [failTool] }), {
        modelProviders: { mock: provider },
      });

      const result = await runtime.run('test');

      // Should still complete — failed tool results are passed back to model
      expect(result.run.turns[0].proposal.type).toBe('tool_call');
    });

    it('tracks spend from financial tools and emits payment events', async () => {
      const payTool = tool({
        name: 'payInvoice',
        description: 'Pay an invoice',
        input: z.object({ recipient: z.string(), chain: z.string() }),
        safetyClass: 'financial',
        costEstimate: () => ({ estimatedUSD: 5, confidence: 0.9 }),
        async execute() {
          return {
            llmOutput: 'Invoice paid',
            success: true,
            metrics: { durationMs: 25, costUSD: 4.25 },
          };
        },
      });

      const provider = mockProvider([
        makeToolCallResponse([{ name: 'payInvoice', args: { recipient: 'vendor_1', chain: 'base', protocol: 'x402' } }]),
        makeResponse('Paid successfully'),
      ]);

      const runtime = new AgentRuntime(
        makeDefinition({
          tools: [payTool],
          payments: { perTransactionLimitUSD: 10, dailyLimitUSD: 100 },
        }),
        {
          modelProviders: { mock: provider },
          agentWallet: {},
        },
      );

      await runtime.run('Pay invoice #123');

      expect(runtime.payments?.getRunSpend()).toBe(4.25);
      const paymentEvent = runtime.eventLog.getAll().find((event) => event.type === 'payment_attempted');
      expect(paymentEvent).toBeDefined();
      expect((paymentEvent as any).data.amountUSD).toBe(4.25);
      expect((paymentEvent as any).data.protocol).toBe('x402');
    });

    it('blocks execution when estimated spend exceeds the configured budget', async () => {
      const expensiveTool = tool({
        name: 'expensiveAction',
        description: 'Runs an expensive action',
        input: z.object({}),
        safetyClass: 'financial',
        costEstimate: () => ({ estimatedUSD: 25, confidence: 0.95 }),
        execute: async () => ({
          llmOutput: 'should never execute',
          success: true,
        }),
      });

      const provider = mockProvider([
        makeToolCallResponse([{ name: 'expensiveAction', args: {} }]),
        makeResponse('Budget prevented the spend'),
      ]);

      const runtime = new AgentRuntime(
        makeDefinition({
          tools: [expensiveTool],
          payments: { perTransactionLimitUSD: 10 },
        }),
        {
          modelProviders: { mock: provider },
          agentWallet: {},
        },
      );

      const result = await runtime.run('Try the expensive action');

      expect(result.run.turns[0].proposal.type).toBe('tool_call');
      expect(result.run.turns[0].result).toMatchObject({
        blocked: true,
        estimatedSpendUSD: 25,
      });
      expect(runtime.payments?.getRunSpend()).toBe(0);
    });
  });

  describe('metadata', () => {
    it('preserves run metadata', async () => {
      const provider = mockProvider([makeResponse('done')]);
      const runtime = new AgentRuntime(makeDefinition(), {
        modelProviders: { mock: provider },
      });

      const result = await runtime.run('test', { source: 'api', userId: '123' });

      expect(result.run.metadata).toEqual({ source: 'api', userId: '123' });
    });

    it('generates unique run IDs', async () => {
      const provider = mockProvider([makeResponse('done')]);
      const runtime = new AgentRuntime(makeDefinition(), {
        modelProviders: { mock: provider },
      });

      const r1 = await runtime.run('test1');
      const r2 = await runtime.run('test2');

      expect(r1.run.id).not.toBe(r2.run.id);
    });
  });
});

describe('createAgent', () => {
  it('returns an AgentRuntime instance', () => {
    const agent = createAgent(makeDefinition());
    expect(agent).toBeInstanceOf(AgentRuntime);
  });

  it('can run with createAgent shorthand', async () => {
    const provider = mockProvider([makeResponse('Hello!')]);
    const agent = createAgent(makeDefinition(), {
      modelProviders: { mock: provider },
    });

    const result = await agent.run('test');
    expect(result.output).toBe('Hello!');
  });
});
