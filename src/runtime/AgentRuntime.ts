/**
 * @packageDocumentation
 * @module AgentRuntime
 * @description
 * The core agent runtime — the main orchestration loop.
 * Assembles context, calls the model, parses proposals, executes tools,
 * runs hooks, manages memory, and emits trace events.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AgentDefinition,
  RuntimeOptions,
} from '../types/agent';
import type {
  Run,
  RunState,
  Turn,
  RunResult,
} from '../types/runtime';
import type {
  ActionProposal,
} from '../types/proposals';
import type {
  ModelMessage,
  ModelResponse,
  ModelProvider,
  ModelToolDefinition,
} from '../types/models';
import type { ToolCall, ToolContract } from '../types/tools';
import type { TraceEvent } from '../types/events';

import { EventBus } from '../events/EventBus';
import { EventLog } from '../events/EventLog';
import { ModelRegistry } from '../models/ModelRegistry';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolExecutor } from '../tools/ToolExecutor';
import { ToolValidator } from '../tools/ToolValidator';
import { HookRegistry } from '../hooks/HookRegistry';
import { HookRunner } from '../hooks/HookRunner';
import { ContextCompiler } from '../context/ContextCompiler';
import { MemoryManager } from '../memory/MemoryManager';
import { CheckpointManager } from '../checkpoints/CheckpointManager';
import { CoreAdapter } from '../integrations/CoreAdapter';
import { PaymentsAdapter } from '../integrations/PaymentsAdapter';
import { PolicyEngine } from '../policy';
import { ApprovalManager } from '../approvals';
import { AuditEmitter } from '../audit';
import type { CheckpointStore } from '../checkpoints/CheckpointManager';
import type { MemoryStore } from '../types/memory';
import type { PolicyRule } from '../policy';
import type { ApprovalRoute } from '../approvals';
import type { AuditSink } from '../audit';

/** Generate a unique event ID. */
function eventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class AgentRuntime {
  readonly definition: AgentDefinition;

  // Sub-systems
  readonly events: EventBus;
  readonly eventLog: EventLog;
  readonly models: ModelRegistry;
  readonly tools: ToolRegistry;
  readonly toolExecutor: ToolExecutor;
  readonly hooks: HookRegistry;
  readonly hookRunner: HookRunner;
  readonly context: ContextCompiler;
  readonly memory: MemoryManager;
  readonly checkpoints: CheckpointManager;

  // Integrations
  readonly core: CoreAdapter | null;
  readonly payments: PaymentsAdapter | null;

  // Governance
  readonly policyEngine: PolicyEngine;
  readonly approvals: ApprovalManager;
  readonly audit: AuditEmitter;

  // Config
  private enableTracing: boolean;
  private enableCheckpoints: boolean;
  private onEvent?: (event: unknown) => void;

  // Run counter
  private runCounter = 0;

  constructor(definition: AgentDefinition, options?: RuntimeOptions) {
    this.definition = definition;

    // Init sub-systems
    this.events = new EventBus();
    this.eventLog = new EventLog();
    this.models = new ModelRegistry();
    this.tools = new ToolRegistry();
    this.toolExecutor = new ToolExecutor(this.tools, new ToolValidator());
    this.hooks = new HookRegistry();
    this.hookRunner = new HookRunner(this.hooks);
    this.context = new ContextCompiler();
    this.memory = new MemoryManager({
      ...definition.memory,
      store: options?.memoryStore as MemoryStore | undefined,
    });
    this.checkpoints = new CheckpointManager(
      options?.checkpointStore as CheckpointStore | undefined,
    );

    // Register model providers
    if (options?.modelProviders) {
      for (const [, provider] of Object.entries(options.modelProviders)) {
        if (provider && typeof provider === 'object' && 'name' in provider) {
          this.models.register(provider as ModelProvider);
        }
      }
    }

    // Register tools
    if (definition.tools) {
      for (const tool of definition.tools) {
        this.tools.register(tool);
      }
    }

    // Register hooks
    if (definition.hooks) {
      for (const [, hooks] of Object.entries(definition.hooks)) {
        for (const hook of hooks) {
          this.hooks.register(hook);
        }
      }
    }

    // Integrations
    this.core = options?.veridexSDK
      ? new CoreAdapter({ sdk: options.veridexSDK })
      : null;
    this.payments = options?.agentWallet
      ? new PaymentsAdapter({
          payments: options.agentWallet,
          budgetLimits: definition.payments
            ? {
                maxPerTransaction: definition.payments.perTransactionLimitUSD,
                maxPerRun: definition.payments.dailyLimitUSD,
              }
            : undefined,
        })
      : null;

    // Config
    this.enableTracing = options?.enableTracing !== false;
    this.enableCheckpoints = options?.enableCheckpoints === true;
    this.onEvent = options?.onEvent as ((event: unknown) => void) | undefined;

    // Governance
    this.policyEngine = new PolicyEngine();
    this.approvals = new ApprovalManager();
    this.audit = new AuditEmitter();

    // Register policy rules from options
    if (options?.policyRules) {
      for (const rule of options.policyRules as PolicyRule[]) {
        this.policyEngine.register(rule);
      }
    }

    // Register approval routes from options
    if (options?.approvalRoutes) {
      for (const route of options.approvalRoutes as ApprovalRoute[]) {
        this.approvals.addRoute(route);
      }
    }

    // Register audit sinks from options
    if (options?.auditSinks) {
      for (const sink of options.auditSinks as AuditSink[]) {
        this.audit.addSink(sink);
      }
    }

    // Wire event forwarding
    if (this.onEvent) {
      const handler = this.onEvent;
      this.events.onAny((event) => handler(event));
    }
    if (this.enableTracing) {
      this.events.onAny((event) => this.eventLog.append(event));
    }
  }

  /** Execute a full agent run. */
  async run(input: string, metadata?: Record<string, unknown>): Promise<RunResult> {
    const runId = `run_${++this.runCounter}_${Date.now()}`;

    const run: Run = {
      id: runId,
      agentId: this.definition.id,
      state: 'queued',
      input,
      turns: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      metadata,
    };

    this.emitEvent({
      id: eventId(),
      type: 'run_started',
      runId,
      agentId: this.definition.id,
      timestamp: Date.now(),
      data: { input },
    });

    // beforeRun hook
    const beforeRun = await this.hookRunner.run('beforeRun', {
      runId, agentId: this.definition.id, input, state: run.state,
    });
    if (beforeRun.override === 'deny') {
      run.state = 'failed';
      run.error = `Run denied by hook: ${beforeRun.reasons.join('; ')}`;
      return this.buildRunResult(run);
    }

    // Main loop
    run.state = 'running';
    const maxTurns = this.definition.maxTurns ?? 25;

    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex++) {
      // beforeTurn hook
      const beforeTurn = await this.hookRunner.run('beforeTurn', {
        runId, agentId: this.definition.id, turnIndex, input,
      });
      if (beforeTurn.override === 'deny') {
        run.state = 'failed';
        run.error = `Turn ${turnIndex} denied by hook: ${beforeTurn.reasons.join('; ')}`;
        break;
      }

      try {
        const turn = await this.executeTurn(run, turnIndex);
        run.turns.push(turn);

        // Accumulate usage
        run.totalUsage.inputTokens += turn.usage.inputTokens;
        run.totalUsage.outputTokens += turn.usage.outputTokens;
        run.totalUsage.totalTokens += turn.usage.totalTokens;
        run.updatedAt = Date.now();

        // Check token budget
        if (this.definition.maxTokens && run.totalUsage.totalTokens > this.definition.maxTokens) {
          run.state = 'failed';
          run.error = `Token budget exceeded (${run.totalUsage.totalTokens}/${this.definition.maxTokens})`;
          break;
        }

        // Determine next state based on proposal
        const nextState = this.getNextState(turn.proposal);
        run.state = nextState;

        if (nextState === 'completed') {
          run.output = turn.proposal.type === 'final_answer'
            ? turn.proposal.answer
            : turn.modelOutput;
          break;
        }

        if (nextState === 'waiting_for_approval' || nextState === 'waiting_for_handoff' || nextState === 'suspended') {
          // Checkpoint if enabled
          if (this.enableCheckpoints) {
            await this.checkpoints.save(runId, this.definition.id, turnIndex, {
              run, turnIndex,
            }, nextState === 'waiting_for_approval' ? 'approval' : 'suspend');
          }
          break;
        }

        // afterTurn hook
        await this.hookRunner.run('afterTurn', {
          runId, agentId: this.definition.id, turnIndex,
          input, output: turn.modelOutput,
        });
      } catch (err) {
        // onError hook
        await this.hookRunner.run('onError', {
          runId, agentId: this.definition.id, turnIndex,
          error: err instanceof Error ? err : new Error(String(err)),
          phase: 'turn',
        });

        run.state = 'failed';
        run.error = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    // If we exhausted turns
    if (run.state === 'running') {
      run.state = 'completed';
      const lastTurn = run.turns[run.turns.length - 1];
      run.output = lastTurn?.modelOutput ?? 'Max turns reached without a final answer.';
    }

    // afterRun hook
    await this.hookRunner.run('afterRun', {
      runId, agentId: this.definition.id, input, state: run.state,
    });

    this.emitEvent({
      id: eventId(),
      type: 'run_completed',
      runId,
      agentId: this.definition.id,
      timestamp: Date.now(),
      data: {
        output: run.output ?? '',
        state: run.state,
        turnCount: run.turns.length,
        totalUsage: run.totalUsage,
      },
    });

    return this.buildRunResult(run);
  }

  /** Execute a single turn. */
  private async executeTurn(run: Run, turnIndex: number): Promise<Turn> {
    const provider = this.models.get(this.definition.model.provider);
    if (!provider) {
      throw new Error(`Model provider '${this.definition.model.provider}' not registered`);
    }

    // Build messages
    const messages = this.buildMessages(run, turnIndex);

    // Build tool definitions for model
    const toolDefs = this.buildToolDefinitions();

    // beforeModelCall hook
    await this.hookRunner.run('beforeModelCall', {
      runId: run.id, agentId: this.definition.id, turnIndex,
      messages, tools: toolDefs,
    });

    this.emitEvent({
      id: eventId(),
      type: 'model_call_started',
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      timestamp: Date.now(),
      data: {
        provider: this.definition.model.provider,
        model: this.definition.model.model,
      },
    });

    // Call model
    const response = await provider.complete(messages, {
      temperature: this.definition.model.temperature,
      maxOutputTokens: this.definition.model.maxOutputTokens,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
    });

    this.emitEvent({
      id: eventId(),
      type: 'model_call_completed',
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      timestamp: Date.now(),
      data: {
        usage: response.usage,
        finishReason: response.finishReason,
      },
    });

    // afterModelCall hook
    await this.hookRunner.run('afterModelCall', {
      runId: run.id, agentId: this.definition.id, turnIndex, response,
    });

    // Parse proposal from response
    const proposal = this.parseProposal(response);

    // Execute proposal
    const result = await this.executeProposal(run, turnIndex, proposal);

    const turn: Turn = {
      index: turnIndex,
      input: messages.map((m) => m.content).join('\n'),
      modelOutput: response.content,
      proposal,
      approved: true,
      result,
      usage: response.usage,
      timestamp: Date.now(),
      events: [],
    };

    return turn;
  }

  /** Build message history for model call. */
  private buildMessages(run: Run, turnIndex: number): ModelMessage[] {
    const messages: ModelMessage[] = [];

    // System message
    messages.push({
      role: 'system',
      content: this.definition.instructions,
    });

    // User input
    messages.push({
      role: 'user',
      content: run.input,
    });

    // Previous turns (conversation history)
    for (const turn of run.turns) {
      // Assistant message
      messages.push({
        role: 'assistant',
        content: turn.modelOutput,
        toolCalls: turn.proposal.type === 'tool_call'
          ? turn.proposal.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            }))
          : undefined,
      });

      // Tool results
      if (turn.proposal.type === 'tool_call' && turn.result) {
        const results = turn.result as Array<{ toolCall: ToolCall; result: { llmOutput: string } }>;
        for (const r of results) {
          messages.push({
            role: 'tool',
            content: r.result.llmOutput,
            toolCallId: r.toolCall.id,
          });
        }
      }
    }

    return messages;
  }

  /** Build tool definitions for the model. */
  private buildToolDefinitions(): ModelToolDefinition[] {
    const tools = this.tools.getAll();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: this.extractJsonSchema(tool),
    }));
  }

  /** Extract JSON Schema from a tool's input definition. */
  private extractJsonSchema(tool: ToolContract): Record<string, unknown> {
    const input = tool.input;
    // Check if it's a Zod schema (has ._def or .parse method)
    if (input && typeof input === 'object' && '_def' in input) {
      // Cast via unknown to break deep Zod generic type chain (TS2589 in DTS generation)
      const convert = zodToJsonSchema as unknown as (
        schema: Record<string, unknown>,
        options: { target: string },
      ) => Record<string, unknown>;
      const schema = convert(input as Record<string, unknown>, { target: 'openApi3' });
      const { $schema: _$schema, ...rest } = schema;
      return rest;
    }
    // Already JSON Schema
    return (input as Record<string, unknown>) ?? { type: 'object', properties: {} };
  }

  /** Parse model response into an ActionProposal. */
  private parseProposal(response: ModelResponse): ActionProposal {
    if (response.toolCalls?.length) {
      return {
        type: 'tool_call',
        toolCalls: response.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: typeof tc.arguments === 'string'
            ? JSON.parse(tc.arguments) as Record<string, unknown>
            : tc.arguments as unknown as Record<string, unknown>,
        })),
      };
    }

    return {
      type: 'final_answer',
      answer: response.content,
    };
  }

  /** Execute an action proposal. */
  private async executeProposal(
    run: Run,
    turnIndex: number,
    proposal: ActionProposal,
  ): Promise<unknown> {
    switch (proposal.type) {
      case 'tool_call': {
        // ── Policy Evaluation ──
        if (this.policyEngine.list().length > 0) {
          const policyContext = {
            agentId: this.definition.id,
            runId: run.id,
            turnIndex,
            proposal,
            runSpendUSD: 0,
            totalTokens: run.totalUsage.totalTokens,
          };

          const decision = await this.policyEngine.evaluate(policyContext);

          this.emitEvent({
            id: eventId(),
            type: 'policy_evaluated',
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            timestamp: Date.now(),
            data: { verdict: decision.verdict, riskScore: decision.riskScore, reasons: decision.reasons },
          } as TraceEvent);

          if (decision.verdict === 'block') {
            return { blocked: true, reasons: decision.reasons };
          }

          if (decision.verdict === 'escalate') {
            // Route through approval manager
            const approvalDecision = await this.approvals.requestApproval(
              run.id,
              this.definition.id,
              turnIndex,
              proposal,
              decision,
            );

            if (!approvalDecision.approved) {
              return { blocked: true, reasons: [`Approval denied: ${approvalDecision.reason}`] };
            }
          }
        }

        const context = {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          sdk: this.core?.isAvailable() ? this.core.getSDK() : undefined,
          wallet: this.payments?.isAvailable() ? this.payments.getPayments() : undefined,
        };

        const results = await this.toolExecutor.executeAll(
          proposal.toolCalls,
          context,
        );

        // Emit tool events
        for (const r of results) {
          this.emitEvent({
            id: eventId(),
            type: 'tool_executed',
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            timestamp: Date.now(),
            data: {
              toolName: r.toolCall.name,
              success: r.result.success !== false,
              durationMs: r.durationMs,
              error: r.result.error,
            },
          });
        }

        return results;
      }

      case 'memory_write': {
        for (const req of proposal.writes) {
          await this.memory.write(req);
        }
        return { written: proposal.writes.length };
      }

      case 'final_answer':
        return undefined;

      case 'handoff':
        return { targetAgentId: proposal.targetAgentId, reason: proposal.reason };

      case 'approval_request':
        return { action: proposal.action, reason: proposal.reason };

      default:
        return undefined;
    }
  }

  /** Determine the next run state from a proposal. */
  private getNextState(proposal: ActionProposal): RunState {
    switch (proposal.type) {
      case 'final_answer':
        return 'completed';
      case 'tool_call':
        return 'running'; // Continue loop after tool execution
      case 'handoff':
        return 'waiting_for_handoff';
      case 'approval_request':
        return 'waiting_for_approval';
      case 'memory_write':
        return 'running'; // Continue after memory write
      default:
        return 'running';
    }
  }

  /** Emit a trace event. */
  private emitEvent(event: TraceEvent): void {
    if (this.enableTracing) {
      this.events.emit(event);
    }
  }

  /** Build the final run result. */
  private buildRunResult(run: Run): RunResult {
    // Emit audit bundle (fire-and-forget)
    this.emitAuditBundle(run).catch(() => {});

    return {
      run,
      output: run.output ?? run.error ?? '',
      events: this.eventLog.getByRun(run.id),
      usage: run.totalUsage,
    };
  }

  /** Emit an audit bundle for a completed run. */
  private async emitAuditBundle(run: Run): Promise<void> {
    const toolExecutions = run.turns
      .filter((t) => t.proposal.type === 'tool_call')
      .flatMap((t, turnIdx) => {
        const results = t.result as Array<{ toolCall: ToolCall; result: { llmOutput: string; success?: boolean }; durationMs: number }> | undefined;
        return (results ?? []).map((r) => ({
          toolName: r.toolCall.name,
          turnIndex: turnIdx,
          success: r.result.success !== false,
          durationMs: r.durationMs,
        }));
      });

    await this.audit.emit({
      runId: run.id,
      agentId: this.definition.id,
      runStartedAt: run.createdAt,
      runEndedAt: run.updatedAt,
      finalState: run.state,
      totalUsage: run.totalUsage,
      totalSpendUSD: 0,
      turnCount: run.turns.length,
      events: this.eventLog.getByRun(run.id),
      policyDecisions: [],
      approvalDecisions: [],
      toolExecutions,
    });
  }
}
