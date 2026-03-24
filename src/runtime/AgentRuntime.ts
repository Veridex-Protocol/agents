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
  HandoffHandler,
} from '../types/agent';
import type {
  Run,
  RunState,
  Turn,
  RunResult,
  ResumeRunOptions,
  RunCheckpointState,
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
import type { ContextPlan, ContextSectionInput } from '../types/context';
import type { MemoryEntry, MemoryWriteRequest } from '../types/memory';

import { EventBus } from '../events/EventBus';
import { EventLog } from '../events/EventLog';
import { ModelRegistry } from '../models/ModelRegistry';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolExecutor } from '../tools/ToolExecutor';
import { ToolValidator } from '../tools/ToolValidator';
import type { ToolExecutionResult } from '../tools/ToolExecutor';
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
import type { HookPhase } from '../types/hooks';
import type { HookRunResult } from '../hooks/HookRunner';

/** Generate a unique event ID. */
function eventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_CONTEXT_TOKEN_BUDGET = 4000;
const DEFAULT_HISTORY_TURNS = 6;

type ProposalExecutionOptions = {
  approval?: ResumeRunOptions['approval'];
};

type ProposalControlResult = {
  blocked?: boolean;
  terminalState?: RunState;
  waitingForApproval?: boolean;
  requestId?: string;
  reasons?: string[];
  approvalMode?: string;
  estimatedSpendUSD?: number;
  output?: string;
  metadata?: Record<string, unknown>;
};

export class AgentRuntime {
  readonly definition: AgentDefinition;

  // Sub-systems
  readonly events: EventBus;
  readonly eventLog: EventLog;
  readonly models: ModelRegistry;
  readonly tools: ToolRegistry;
  readonly toolValidator: ToolValidator;
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
  private latestContextPlans = new Map<string, ContextPlan>();
  private traceHookActive = false;
  private handoffHandlers = new Map<string, HandoffHandler>();

  // Run counter
  private runCounter = 0;

  constructor(definition: AgentDefinition, options?: RuntimeOptions) {
    this.definition = definition;

    // Init sub-systems
    this.events = new EventBus();
    this.eventLog = new EventLog();
    this.models = new ModelRegistry();
    this.tools = new ToolRegistry();
    this.toolValidator = new ToolValidator();
    this.toolExecutor = new ToolExecutor(this.tools, this.toolValidator);
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
    if (options?.handoffHandlers) {
      for (const [target, handler] of Object.entries(options.handoffHandlers)) {
        this.handoffHandlers.set(target, handler);
      }
    }

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

  /** Get the most recently compiled context plan for a run. */
  getLatestContextPlan(runId?: string): ContextPlan | null {
    if (runId) {
      return this.latestContextPlans.get(runId) ?? null;
    }

    const latestRunId = [...this.latestContextPlans.keys()].at(-1);
    if (!latestRunId) return null;
    return this.latestContextPlans.get(latestRunId) ?? null;
  }

  /** List checkpoints for a run. */
  async listCheckpoints(runId: string) {
    return this.checkpoints.list(runId);
  }

  /** Load a stored checkpoint. */
  async loadCheckpoint(checkpointId: string) {
    return this.checkpoints.load(checkpointId);
  }

  /** Resume a suspended run from a previously saved checkpoint. */
  async resumeFromCheckpoint(
    checkpointId: string,
    options?: ResumeRunOptions,
  ): Promise<RunResult> {
    const checkpoint = await this.checkpoints.load(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint '${checkpointId}' not found`);
    }

    const parsed = this.checkpoints.parseState(checkpoint) as unknown as RunCheckpointState;
    if (!parsed.run) {
      throw new Error(`Checkpoint '${checkpointId}' does not contain a run snapshot`);
    }

    const run: Run = {
      ...parsed.run,
      turns: [...parsed.run.turns],
      updatedAt: Date.now(),
    };
    const startTurnIndex = (parsed.turnIndex ?? run.turns.length - 1) + 1;

    const approval = options?.approval;
    if (run.state === 'waiting_for_approval') {
      const lastTurn = run.turns[run.turns.length - 1];
      if (!approval) {
        return this.buildRunResult(run);
      }

      if (!approval.approved) {
        if (approval.requestId) {
          this.approvals.resolve(
            approval.requestId,
            false,
            approval.approver ?? 'operator',
            approval.reason,
          );
        }
        await this.runHooks('afterApprovalDecision', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex: lastTurn?.index ?? parsed.turnIndex ?? 0,
          approved: false,
          requestId: approval.requestId,
          approver: approval.approver ?? 'operator',
          reason: approval.reason,
        }, { runId: run.id, turnIndex: lastTurn?.index });
        run.state = 'failed';
        run.error = approval.reason ?? 'Approval denied';
        return this.finalizeRun(run);
      }

      if (
        lastTurn &&
        lastTurn.proposal.type === 'tool_call' &&
        lastTurn.result &&
        typeof lastTurn.result === 'object' &&
        'waitingForApproval' in (lastTurn.result as Record<string, unknown>)
      ) {
        lastTurn.result = await this.executeProposal(
          run,
          lastTurn.index,
          lastTurn.proposal,
          { approval },
        );
        run.state = 'running';
      } else {
        run.state = 'running';
      }

      if (approval.requestId) {
        this.approvals.resolve(
          approval.requestId,
          true,
          approval.approver ?? 'operator',
          approval.reason,
        );
      }
      if (!lastTurn || lastTurn.proposal.type !== 'tool_call') {
        await this.runHooks('afterApprovalDecision', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex: lastTurn?.index ?? parsed.turnIndex ?? 0,
          approved: true,
          requestId: approval.requestId,
          approver: approval.approver ?? 'operator',
          reason: approval.reason,
        }, { runId: run.id, turnIndex: lastTurn?.index });
      }
    }

    return this.executeRunLoop(run, startTurnIndex, { skipBeforeRun: true });
  }

  /** Execute a full agent run. */
  async run(input: string, metadata?: Record<string, unknown>): Promise<RunResult> {
    const runId = `run_${++this.runCounter}_${Date.now()}`;
    this.payments?.resetRunSpend();

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
    const beforeRun = await this.runHooks('beforeRun', {
      runId, agentId: this.definition.id, input, state: run.state,
    }, { runId });
    if (beforeRun.override === 'deny') {
      run.state = 'failed';
      run.error = `Run denied by hook: ${beforeRun.reasons.join('; ')}`;
      return this.finalizeRun(run);
    }

    return this.executeRunLoop(run, 0);
  }

  /** Continue executing a run from the given turn index. */
  private async executeRunLoop(
    run: Run,
    startTurnIndex: number,
    options?: { skipBeforeRun?: boolean },
  ): Promise<RunResult> {
    run.state = 'running';
    const maxTurns = this.definition.maxTurns ?? 25;

    for (let turnIndex = startTurnIndex; turnIndex < maxTurns; turnIndex++) {
      // beforeTurn hook
      const beforeTurn = await this.runHooks('beforeTurn', {
        runId: run.id,
        agentId: this.definition.id,
        turnIndex,
        input: run.input,
      }, { runId: run.id, turnIndex });
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
        const nextState = this.getNextState(turn.proposal, turn.result);
        run.state = nextState;

        if (nextState === 'completed') {
          const control = turn.result as ProposalControlResult | undefined;
          run.output = control?.output
            ?? (turn.proposal.type === 'final_answer'
              ? turn.proposal.answer
              : turn.modelOutput);
          break;
        }

        if (nextState === 'failed') {
          const turnResult = turn.result as ProposalControlResult | undefined;
          run.error = turnResult?.reasons?.join('; ') ?? 'Run blocked';
          break;
        }

        if (nextState === 'waiting_for_approval' || nextState === 'waiting_for_handoff' || nextState === 'suspended') {
          // Checkpoint if enabled
          if (this.enableCheckpoints) {
            const checkpoint = await this.checkpoints.save(run.id, this.definition.id, turnIndex, {
              run, turnIndex,
            }, nextState === 'waiting_for_approval' ? 'approval' : 'suspend');
            this.emitEvent({
              id: eventId(),
              type: 'run_checkpointed',
              runId: run.id,
              agentId: this.definition.id,
              turnIndex,
              timestamp: Date.now(),
              data: {
                checkpointId: checkpoint.id,
                turnIndex,
                state: nextState,
              },
            });
          }
          break;
        }

        // afterTurn hook
        await this.runHooks('afterTurn', {
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          input: run.input,
          output: turn.modelOutput,
        }, { runId: run.id, turnIndex });
      } catch (err) {
        // onError hook
        await this.runHooks('onError', {
          runId: run.id, agentId: this.definition.id, turnIndex,
          error: err instanceof Error ? err : new Error(String(err)),
          phase: 'turn',
        }, { runId: run.id, turnIndex });

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
    if (!options?.skipBeforeRun || startTurnIndex > 0) {
      await this.runHooks('afterRun', {
        runId: run.id,
        agentId: this.definition.id,
        input: run.input,
        state: run.state,
      }, { runId: run.id });
    }

    return this.finalizeRun(run);
  }

  /** Execute a single turn. */
  private async executeTurn(run: Run, turnIndex: number): Promise<Turn> {
    const provider = this.models.get(this.definition.model.provider);
    if (!provider) {
      throw new Error(`Model provider '${this.definition.model.provider}' not registered`);
    }

    // Build messages
    const { messages, contextPlan } = await this.buildMessages(run, turnIndex);
    this.latestContextPlans.set(run.id, contextPlan);

    this.emitEvent({
      id: eventId(),
      type: 'context_compiled',
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      timestamp: Date.now(),
      data: {
        totalTokens: contextPlan.totalTokens,
        sectionCount: contextPlan.sections.length,
        hadTruncation: contextPlan.hadTruncation,
      },
    });

    // Build tool definitions for model
    const toolDefs = this.buildToolDefinitions();

    // beforeModelCall hook
    await this.runHooks('beforeModelCall', {
      runId: run.id, agentId: this.definition.id, turnIndex,
      messages, tools: toolDefs,
    }, { runId: run.id, turnIndex });

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
    await this.runHooks('afterModelCall', {
      runId: run.id, agentId: this.definition.id, turnIndex, response,
    }, { runId: run.id, turnIndex });

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
  private async buildMessages(
    run: Run,
    turnIndex: number,
  ): Promise<{ messages: ModelMessage[]; contextPlan: ContextPlan }> {
    const messages: ModelMessage[] = [];
    const contextPlan = await this.buildAuxiliaryContext(run, turnIndex);

    // System message
    messages.push({
      role: 'system',
      content: this.definition.instructions,
    });

    const formattedContext = this.formatContextPlan(contextPlan);
    if (formattedContext) {
      messages.push({
        role: 'system',
        content: formattedContext,
      });
    }

    // User input
    messages.push({
      role: 'user',
      content: run.input,
    });

    // Previous turns (conversation history)
    const historyTurns = run.turns.slice(-DEFAULT_HISTORY_TURNS);
    for (const turn of historyTurns) {
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
        const results = turn.result as Array<{ toolCall: ToolCall; result: { llmOutput: string } }> | ProposalControlResult;
        if (Array.isArray(results)) {
          for (const r of results) {
            messages.push({
              role: 'tool',
              content: r.result.llmOutput,
              toolCallId: r.toolCall.id,
            });
          }
        }
      }
    }

    return { messages, contextPlan };
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

    const trimmed = response.content.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
          switch (parsed.type) {
            case 'final_answer':
              if (typeof parsed.answer === 'string') {
                return { type: 'final_answer', answer: parsed.answer };
              }
              break;
            case 'tool_call':
              if (Array.isArray(parsed.toolCalls)) {
                return {
                  type: 'tool_call',
                  toolCalls: parsed.toolCalls
                    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
                    .map((tc, index) => ({
                      id: typeof tc.id === 'string' ? tc.id : `tc_json_${index}`,
                      name: typeof tc.name === 'string' ? tc.name : 'unknown_tool',
                      arguments: (tc.arguments && typeof tc.arguments === 'object')
                        ? tc.arguments as Record<string, unknown>
                        : {},
                    })),
                };
              }
              break;
            case 'memory_write':
              if (Array.isArray(parsed.writes)) {
                return {
                  type: 'memory_write',
                  writes: parsed.writes as MemoryWriteRequest[],
                };
              }
              break;
            case 'handoff':
              if (typeof parsed.targetAgentId === 'string' && typeof parsed.reason === 'string') {
                return {
                  type: 'handoff',
                  targetAgentId: parsed.targetAgentId,
                  reason: parsed.reason,
                  context: typeof parsed.context === 'string' ? parsed.context : undefined,
                };
              }
              break;
            case 'approval_request':
              if (typeof parsed.action === 'string' && typeof parsed.reason === 'string') {
                return {
                  type: 'approval_request',
                  action: parsed.action,
                  reason: parsed.reason,
                  riskScore: typeof parsed.riskScore === 'number' ? parsed.riskScore : 0,
                  details: parsed.details && typeof parsed.details === 'object'
                    ? parsed.details as Record<string, unknown>
                    : undefined,
                };
              }
              break;
            default:
              break;
          }
        }
      } catch {
        // Fall through to final_answer.
      }
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
    options?: ProposalExecutionOptions,
  ): Promise<unknown> {
    switch (proposal.type) {
      case 'tool_call': {
        for (const toolCall of proposal.toolCalls) {
          const tool = this.tools.get(toolCall.name);
          this.emitEvent({
            id: eventId(),
            type: 'tool_proposed',
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            timestamp: Date.now(),
            data: {
              toolName: toolCall.name,
              arguments: toolCall.arguments,
              safetyClass: tool?.safetyClass ?? 'unknown',
            },
          });
        }

        // ── Policy Evaluation ──
        if (this.policyEngine.list().length > 0) {
          const policyContext = {
            agentId: this.definition.id,
            runId: run.id,
            turnIndex,
            proposal,
            runSpendUSD: this.payments?.getRunSpend() ?? 0,
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
            await this.runHooks('onPolicyViolation', {
              runId: run.id,
              agentId: this.definition.id,
              turnIndex,
              proposal,
              decision,
            }, { runId: run.id, turnIndex });
            return {
              blocked: true,
              terminalState: 'failed',
              reasons: decision.reasons,
            } satisfies ProposalControlResult;
          }

          if (decision.verdict === 'escalate' && !options?.approval?.approved) {
            await this.runHooks('onPolicyViolation', {
              runId: run.id,
              agentId: this.definition.id,
              turnIndex,
              proposal,
              decision,
            }, { runId: run.id, turnIndex });

            const beforeApproval = await this.runHooks('beforeApprovalRequest', {
              runId: run.id,
              agentId: this.definition.id,
              turnIndex,
              proposal,
              decision,
            }, { runId: run.id, turnIndex });
            if (beforeApproval.override === 'deny') {
              return {
                blocked: true,
                terminalState: 'failed',
                reasons: beforeApproval.reasons,
              } satisfies ProposalControlResult;
            }

            const started = await this.approvals.startApproval(
              run.id,
              this.definition.id,
              turnIndex,
              proposal,
              decision,
              { autoResolve: false },
            );

            if (!started.decision) {
              this.emitEvent({
                id: eventId(),
                type: 'approval_requested',
                runId: run.id,
                agentId: this.definition.id,
                turnIndex,
                timestamp: Date.now(),
                data: {
                  action: 'tool_call',
                  reason: started.request.reason,
                  riskScore: decision.riskScore,
                },
              });
              return {
                blocked: true,
                waitingForApproval: true,
                requestId: started.request.id,
                approvalMode: started.request.mode,
                reasons: [started.request.reason],
              } satisfies ProposalControlResult;
            }

            await this.runHooks('afterApprovalDecision', {
              runId: run.id,
              agentId: this.definition.id,
              turnIndex,
              requestId: started.request.id,
              approved: started.decision.approved,
              approver: started.decision.decidedBy,
              reason: started.decision.reason,
            }, { runId: run.id, turnIndex });

            if (!started.decision.approved) {
              return {
                blocked: true,
                terminalState: 'failed',
                reasons: [`Approval denied: ${started.decision.reason ?? 'Unknown reason'}`],
              } satisfies ProposalControlResult;
            }
          }
        }

        if (options?.approval?.approved) {
          await this.runHooks('afterApprovalDecision', {
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            requestId: options.approval.requestId,
            approved: true,
            approver: options.approval.approver ?? 'operator',
            reason: options.approval.reason,
          }, { runId: run.id, turnIndex });
        }

        if (this.payments?.isAvailable()) {
          for (const toolCall of proposal.toolCalls) {
            const tool = this.tools.get(toolCall.name);
            const estimate = tool?.costEstimate?.(toolCall.arguments);
            if (!estimate) continue;

            const beforePayment = await this.runHooks('beforePayment', {
              runId: run.id,
              agentId: this.definition.id,
              turnIndex,
              toolName: toolCall.name,
              estimate,
            }, { runId: run.id, turnIndex });
            if (beforePayment.override === 'deny') {
              return {
                blocked: true,
                terminalState: 'failed',
                reasons: beforePayment.reasons,
              } satisfies ProposalControlResult;
            }

            const budget = this.payments.checkBudget(estimate.estimatedUSD);
            if (!budget.allowed) {
              return {
                blocked: true,
                terminalState: 'failed',
                reasons: [budget.reason ?? 'Budget check failed'],
                estimatedSpendUSD: estimate.estimatedUSD,
              } satisfies ProposalControlResult;
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

        const results: ToolExecutionResult[] = [];
        for (const toolCall of proposal.toolCalls) {
          const tool = this.tools.get(toolCall.name);
          const toolName = toolCall.name;
          const safetyClass = tool?.safetyClass ?? 'read';

          const beforeValidation = await this.runHooks('beforeToolValidation', {
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            toolName,
            toolInput: toolCall.arguments,
            safetyClass,
          }, { runId: run.id, turnIndex });

          if (beforeValidation.override === 'deny') {
            results.push({
              toolCall,
              result: {
                llmOutput: '',
                success: false,
                error: beforeValidation.reasons.join('; ') || 'Tool validation denied by hook',
              },
              durationMs: 0,
              retryCount: 0,
            });
            continue;
          }

          const validationError = tool
            ? this.toolValidator.validateInput(tool, toolCall.arguments)
            : `Tool '${toolName}' not found`;

          await this.runHooks('afterToolValidation', {
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            toolName,
            toolInput: toolCall.arguments,
            safetyClass,
            passed: !validationError,
            error: validationError,
          }, { runId: run.id, turnIndex });

          if (validationError) {
            results.push({
              toolCall,
              result: {
                llmOutput: `Validation error: ${validationError}`,
                success: false,
                error: validationError,
              },
              durationMs: 0,
              retryCount: 0,
            });
            continue;
          }

          const beforeExecute = await this.runHooks('beforeToolExecute', {
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            toolName,
            toolInput: toolCall.arguments,
            safetyClass,
          }, { runId: run.id, turnIndex });

          if (beforeExecute.override === 'deny') {
            results.push({
              toolCall,
              result: {
                llmOutput: '',
                success: false,
                error: beforeExecute.reasons.join('; ') || 'Tool execution denied by hook',
              },
              durationMs: 0,
              retryCount: 0,
            });
            continue;
          }

          const execution = await this.toolExecutor.execute(toolCall, context);

          await this.runHooks('afterToolExecute', {
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            toolName,
            toolInput: toolCall.arguments,
            toolOutput: execution.result,
            safetyClass,
            success: execution.result.success,
          }, { runId: run.id, turnIndex });

          results.push(execution);
        }

        // Emit tool events
        for (const r of results) {
          const tool = this.tools.get(r.toolCall.name);
          const amountUSD = r.result.metrics?.costUSD;

          if (
            amountUSD !== undefined &&
            amountUSD > 0 &&
            this.payments?.isAvailable()
          ) {
            this.payments.recordSpend(amountUSD);
          }

          if (amountUSD !== undefined || tool?.safetyClass === 'financial') {
            this.emitEvent({
              id: eventId(),
              type: 'payment_attempted',
              runId: run.id,
              agentId: this.definition.id,
              turnIndex,
              timestamp: Date.now(),
              data: {
                protocol: typeof r.toolCall.arguments.protocol === 'string'
                  ? r.toolCall.arguments.protocol
                  : 'tool',
                amountUSD: amountUSD ?? 0,
                chain: typeof r.toolCall.arguments.chain === 'string'
                  ? r.toolCall.arguments.chain
                  : 'unknown',
                recipient: typeof r.toolCall.arguments.recipient === 'string'
                  ? r.toolCall.arguments.recipient
                  : r.toolCall.name,
                success: r.result.success !== false,
                txHash: typeof r.toolCall.arguments.txHash === 'string'
                  ? r.toolCall.arguments.txHash
                  : undefined,
                error: r.result.error,
              },
            });
            await this.runHooks('afterPayment', {
              runId: run.id,
              agentId: this.definition.id,
              turnIndex,
              toolName: r.toolCall.name,
              amountUSD: amountUSD ?? 0,
              success: r.result.success !== false,
              error: r.result.error,
            }, { runId: run.id, turnIndex });
          }

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
          const beforeWrite = await this.runHooks('beforeMemoryWrite', {
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            request: req,
          }, { runId: run.id, turnIndex });
          if (beforeWrite.override === 'deny') {
            continue;
          }

          const entry = await this.memory.write(req);
          this.emitEvent({
            id: eventId(),
            type: 'memory_written',
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            timestamp: Date.now(),
            data: {
              tier: entry.tier,
              entryId: entry.id,
              scope: entry.scope,
              provenance: entry.provenance,
            },
          });
          await this.runHooks('afterMemoryWrite', {
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            entry,
          }, { runId: run.id, turnIndex });
        }
        return { written: proposal.writes.length };
      }

      case 'final_answer':
        return undefined;

      case 'handoff':
        {
          const beforeHandoff = await this.runHooks('beforeHandoff', {
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            proposal,
          }, { runId: run.id, turnIndex });
          if (beforeHandoff.override === 'deny') {
            return {
              blocked: true,
              terminalState: 'failed',
              reasons: beforeHandoff.reasons,
            } satisfies ProposalControlResult;
          }
        this.emitEvent({
          id: eventId(),
          type: 'handoff_initiated',
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          timestamp: Date.now(),
          data: {
            targetAgentId: proposal.targetAgentId,
            reason: proposal.reason,
          },
        });
          const handler = this.handoffHandlers.get(proposal.targetAgentId);
          if (handler) {
            const handoff = await handler({
              runId: run.id,
              agentId: this.definition.id,
              turnIndex,
              targetAgentId: proposal.targetAgentId,
              reason: proposal.reason,
              context: proposal.context,
              sdk: this.core?.getSDK(),
              wallet: this.payments?.getPayments(),
            });

            await this.runHooks('afterHandoff', {
              runId: run.id,
              agentId: this.definition.id,
              turnIndex,
              proposal,
              result: handoff,
            }, { runId: run.id, turnIndex });

            if (!handoff.success) {
              return {
                blocked: true,
                terminalState: 'failed',
                reasons: [handoff.error ?? `Handoff to "${proposal.targetAgentId}" failed`],
                metadata: handoff.metadata,
              } satisfies ProposalControlResult;
            }

            return {
              terminalState: 'completed',
              output: handoff.output,
              metadata: handoff.metadata,
            } satisfies ProposalControlResult;
          }

          await this.runHooks('afterHandoff', {
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            proposal,
          }, { runId: run.id, turnIndex });
        return { targetAgentId: proposal.targetAgentId, reason: proposal.reason };
        }

      case 'approval_request':
        {
          const beforeApproval = await this.runHooks('beforeApprovalRequest', {
            runId: run.id,
            agentId: this.definition.id,
            turnIndex,
            proposal,
          }, { runId: run.id, turnIndex });
          if (beforeApproval.override === 'deny') {
            return {
              blocked: true,
              terminalState: 'failed',
              reasons: beforeApproval.reasons,
            } satisfies ProposalControlResult;
          }
        this.emitEvent({
          id: eventId(),
          type: 'approval_requested',
          runId: run.id,
          agentId: this.definition.id,
          turnIndex,
          timestamp: Date.now(),
          data: {
            action: proposal.action,
            reason: proposal.reason,
            riskScore: proposal.riskScore,
          },
        });
          return {
            action: proposal.action,
            reason: proposal.reason,
            waitingForApproval: true,
          };
        }

      default:
        return undefined;
    }
  }

  /** Determine the next run state from a proposal. */
  private getNextState(proposal: ActionProposal, result?: unknown): RunState {
    const control = result as ProposalControlResult | undefined;
    if (control?.terminalState) {
      return control.terminalState;
    }
    if (control?.waitingForApproval) {
      return 'waiting_for_approval';
    }

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
      if (!this.traceHookActive && event.type !== 'hook_executed') {
        this.traceHookActive = true;
        void this.hookRunner
          .run('onTraceEvent', { event })
          .catch(() => undefined)
          .finally(() => {
            this.traceHookActive = false;
          });
      }
    }
  }

  private async runHooks(
    phase: HookPhase,
    context: unknown,
    eventContext: { runId: string; turnIndex?: number },
  ): Promise<HookRunResult> {
    const startedAt = Date.now();
    const result = await this.hookRunner.run(phase, context);

    this.emitEvent({
      id: eventId(),
      type: 'hook_executed',
      runId: eventContext.runId,
      agentId: this.definition.id,
      turnIndex: eventContext.turnIndex,
      timestamp: Date.now(),
      data: {
        hookName: phase,
        phase,
        durationMs: Date.now() - startedAt,
        override: result.override === 'continue' ? undefined : result.override,
      },
    });

    return result;
  }

  private async buildAuxiliaryContext(
    run: Run,
    turnIndex: number,
  ): Promise<ContextPlan> {
    const sections: ContextSectionInput[] = [];

    const runState = this.serializeRunState(run, turnIndex);
    if (runState) {
      sections.push({
        id: 'run-state',
        source: 'run_state',
        content: runState,
        priority: 100,
        budgetTokens: 250,
      });
    }

    const budgetSummary = this.serializeBudgetState(run);
    if (budgetSummary) {
      sections.push({
        id: 'budget',
        source: 'budget',
        content: budgetSummary,
        priority: 95,
        budgetTokens: 180,
      });
    }

    const paymentConstraints = this.serializePaymentConstraints();
    if (paymentConstraints) {
      sections.push({
        id: 'payment-constraints',
        source: 'payment_constraints',
        content: paymentConstraints,
        priority: 90,
        budgetTokens: 160,
      });
    }

    const toolCatalog = this.serializeToolCatalog();
    if (toolCatalog) {
      sections.push({
        id: 'tools',
        source: 'tools',
        content: toolCatalog,
        priority: 70,
        budgetTokens: 700,
        truncation: 'tail',
      });
    }

    const memorySections = await this.buildMemoryContextSections(run.id);
    sections.push(...memorySections);

    const beforeCompile = await this.runHooks('beforeContextCompile', {
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      sections,
    }, { runId: run.id, turnIndex });
    if (beforeCompile.override === 'deny') {
      throw new Error(`Context compilation denied by hook: ${beforeCompile.reasons.join('; ')}`);
    }

    const plan = this.context.compile({
      maxTokens: this.estimateContextBudget(run),
      sections,
      includeMemory: memorySections.length > 0,
      includeTools: this.tools.getAll().length > 0,
      includeHistory: run.turns.length > 0,
      maxHistoryTurns: DEFAULT_HISTORY_TURNS,
    });

    const afterCompile = await this.runHooks('afterContextCompile', {
      runId: run.id,
      agentId: this.definition.id,
      turnIndex,
      plan,
    }, { runId: run.id, turnIndex });
    if (afterCompile.override === 'deny') {
      throw new Error(`Compiled context rejected by hook: ${afterCompile.reasons.join('; ')}`);
    }

    return plan;
  }

  private estimateContextBudget(run: Run): number {
    if (this.definition.maxTokens) {
      const remaining = Math.max(this.definition.maxTokens - run.totalUsage.totalTokens, 256);
      return Math.min(DEFAULT_CONTEXT_TOKEN_BUDGET, remaining);
    }
    return DEFAULT_CONTEXT_TOKEN_BUDGET;
  }

  private serializeRunState(run: Run, turnIndex: number): string {
    const parts = [
      `Run ID: ${run.id}`,
      `Turn: ${turnIndex + 1}`,
      `State: ${run.state}`,
    ];

    if (run.metadata && Object.keys(run.metadata).length > 0) {
      parts.push(`Run metadata: ${JSON.stringify(run.metadata)}`);
    }
    if (this.definition.metadata && Object.keys(this.definition.metadata).length > 0) {
      parts.push(`Agent metadata: ${JSON.stringify(this.definition.metadata)}`);
    }

    return parts.join('\n');
  }

  private serializeBudgetState(run: Run): string {
    const parts = [`Total tokens used so far: ${run.totalUsage.totalTokens}`];

    if (this.definition.maxTokens) {
      parts.push(`Max tokens allowed: ${this.definition.maxTokens}`);
    }
    if (this.payments?.isAvailable()) {
      parts.push(`Run spend so far (USD): ${this.payments.getRunSpend()}`);
    }

    return parts.join('\n');
  }

  private serializePaymentConstraints(): string {
    if (!this.definition.payments) return '';

    const parts: string[] = [];
    if (this.definition.payments.dailyLimitUSD !== undefined) {
      parts.push(`Daily spend limit USD: ${this.definition.payments.dailyLimitUSD}`);
    }
    if (this.definition.payments.perTransactionLimitUSD !== undefined) {
      parts.push(
        `Per-transaction spend limit USD: ${this.definition.payments.perTransactionLimitUSD}`,
      );
    }
    if (this.definition.payments.allowedChains?.length) {
      parts.push(`Allowed chains: ${this.definition.payments.allowedChains.join(', ')}`);
    }
    if (this.definition.payments.allowedProtocols?.length) {
      parts.push(
        `Allowed payment protocols: ${this.definition.payments.allowedProtocols.join(', ')}`,
      );
    }
    if (this.definition.payments.requireApproval) {
      parts.push('Financial actions require approval.');
    }

    return parts.join('\n');
  }

  private serializeToolCatalog(): string {
    const tools = this.tools.getAll();
    if (tools.length === 0) return '';

    return tools.map((tool) => {
      const detail: string[] = [
        `- ${tool.name} [${tool.safetyClass}]`,
        `  ${tool.description}`,
      ];
      if (tool.permissions?.length) {
        detail.push(`  permissions: ${tool.permissions.join(', ')}`);
      }
      if (tool.timeoutMs) {
        detail.push(`  timeoutMs: ${tool.timeoutMs}`);
      }
      return detail.join('\n');
    }).join('\n');
  }

  private async buildMemoryContextSections(_runId: string): Promise<ContextSectionInput[]> {
    const sections: ContextSectionInput[] = [];

    const working = await this.memory.search({
      tier: 'working',
      scope: 'run',
      limit: 5,
    });
    if (working.length > 0) {
      sections.push({
        id: 'memory-working',
        source: 'memory',
        content: this.serializeMemoryEntries('Working memory', working),
        priority: 85,
        budgetTokens: 400,
      });
    }

    const episodic = await this.memory.search({
      tier: 'episodic',
      limit: 3,
    });
    if (episodic.length > 0) {
      sections.push({
        id: 'memory-episodic',
        source: 'memory',
        content: this.serializeMemoryEntries('Episodic memory', episodic),
        priority: 65,
        budgetTokens: 280,
      });
    }

    const semantic = await this.memory.search({
      tier: 'semantic',
      limit: 5,
    });
    if (semantic.length > 0) {
      sections.push({
        id: 'memory-semantic',
        source: 'memory',
        content: this.serializeMemoryEntries('Semantic memory', semantic),
        priority: 75,
        budgetTokens: 320,
      });
    }

    const procedural = await this.memory.search({
      tier: 'procedural',
      limit: 3,
    });
    if (procedural.length > 0) {
      sections.push({
        id: 'memory-procedural',
        source: 'memory',
        content: this.serializeMemoryEntries('Procedural memory', procedural),
        priority: 60,
        budgetTokens: 240,
      });
    }

    return sections;
  }

  private serializeMemoryEntries(label: string, entries: MemoryEntry[]): string {
    const lines = [`${label}:`];
    for (const entry of entries) {
      lines.push(
        `- (${entry.tier}/${entry.scope}, confidence=${entry.confidence.toFixed(2)}) ${entry.content}`,
      );
    }
    return lines.join('\n');
  }

  private formatContextPlan(plan: ContextPlan): string {
    const nonEmptySections = plan.sections.filter((section) => section.content.trim().length > 0);
    if (nonEmptySections.length === 0) return '';

    const parts: string[] = [
      'Runtime context:',
      `- compiled tokens: ${plan.totalTokens}/${plan.budgetTokens}`,
      `- truncated: ${plan.hadTruncation ? 'yes' : 'no'}`,
      '',
    ];

    for (const section of nonEmptySections) {
      parts.push(`## ${section.id}`);
      parts.push(section.content);
      parts.push('');
    }

    return parts.join('\n').trim();
  }

  private finalizeRun(run: Run): RunResult {
    run.updatedAt = Date.now();

    const isTerminal = run.state === 'completed' || run.state === 'failed';
    if (isTerminal) {
      this.emitEvent({
        id: eventId(),
        type: 'run_completed',
        runId: run.id,
        agentId: this.definition.id,
        timestamp: Date.now(),
        data: {
          output: run.output ?? '',
          state: run.state,
          turnCount: run.turns.length,
          totalUsage: run.totalUsage,
        },
      });
    }

    if (run.state === 'failed') {
      const failedTurnIndex = run.turns.length > 0
        ? run.turns[run.turns.length - 1].index
        : 0;
      this.emitEvent({
        id: eventId(),
        type: 'run_failed',
        runId: run.id,
        agentId: this.definition.id,
        turnIndex: failedTurnIndex,
        timestamp: Date.now(),
        data: {
          error: run.error ?? 'Run failed',
          turnIndex: failedTurnIndex,
        },
      });
    }

    return this.buildRunResult(run);
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
        if (!Array.isArray(results)) {
          return [];
        }
        return results.map((r) => ({
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
      totalSpendUSD: this.payments?.getRunSpend() ?? 0,
      turnCount: run.turns.length,
      events: this.eventLog.getByRun(run.id),
      policyDecisions: [],
      approvalDecisions: [],
      toolExecutions,
    });
  }
}
