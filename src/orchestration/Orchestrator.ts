/**
 * @module Orchestrator
 * @description
 * Multi-agent orchestrator for the Veridex Agent Fabric.
 *
 * Coordinates multiple AgentRuntime instances through a dependency-aware
 * task graph, with capability-based scheduling, shared memory between
 * agents, concurrent execution, and structured progress events.
 *
 * Unlike the single-agent handoff pattern (one-to-one, synchronous),
 * the Orchestrator supports:
 * - One-to-many task decomposition
 * - Parallel dispatch of independent tasks
 * - Dependency-aware ordering
 * - Shared results across the team via memory
 * - Structured progress callbacks
 *
 * @example
 * ```ts
 * const orchestrator = new Orchestrator({
 *   team: {
 *     id: 'research-team',
 *     name: 'Research Team',
 *     members: [
 *       { definition: researcherDef, capabilities: ['research'] },
 *       { definition: writerDef, capabilities: ['writing'] },
 *     ],
 *     maxConcurrency: 3,
 *   },
 *   onProgress: (event) => console.log(event),
 * });
 *
 * const t1 = orchestrator.addTask({ title: 'Research topic', description: '...' });
 * const t2 = orchestrator.addTask({ title: 'Write report', description: '...', dependsOn: [t1.id] });
 * const result = await orchestrator.run();
 * ```
 */

import { AgentRuntime } from '../runtime/AgentRuntime';
import { TaskGraph } from './TaskGraph';
import { Scheduler } from './Scheduler';
import type {
  AgentExecutor,
  CreateOrchestrationTaskOptions,
  OrchestratorConfig,
  OrchestratorEvent,
  OrchestratorResult,
  OrchestrationTask,
  TeamMember,
} from './types';
import type { RuntimeOptions } from '../types/agent';
import type { RunResult } from '../types/runtime';

const DEFAULT_MAX_CONCURRENCY = 5;

export class Orchestrator {
  readonly graph: TaskGraph;
  readonly config: OrchestratorConfig;
  private readonly scheduler: Scheduler;
  private readonly agentResults: Map<string, RunResult> = new Map();
  private readonly sharedMemory: Map<string, string> = new Map();
  private readonly executor: AgentExecutor;

  constructor(config: OrchestratorConfig, executor?: AgentExecutor) {
    this.config = config;
    this.graph = new TaskGraph();
    this.scheduler = new Scheduler({
      strategy: config.schedulerStrategy ?? 'capability-match',
    });
    this.executor = executor ?? this.defaultExecutor.bind(this);
  }

  /** Add a task to the orchestration graph. */
  addTask(options: CreateOrchestrationTaskOptions): OrchestrationTask {
    const task = this.graph.addTask(options);
    this.emitEvent('task_created', task.id);
    return task;
  }

  /** Get the current task graph snapshot. */
  getTasks(): OrchestrationTask[] {
    return this.graph.getAllTasks();
  }

  /** Get per-agent run results. */
  getAgentResults(): Map<string, RunResult> {
    return new Map(this.agentResults);
  }

  /** Get shared memory state. */
  getSharedMemory(): Map<string, string> {
    return new Map(this.sharedMemory);
  }

  /**
   * Execute all tasks in the graph, respecting dependencies and concurrency.
   *
   * The orchestration loop works in rounds:
   * 1. Auto-assign unassigned pending tasks via the scheduler
   * 2. Dispatch all assigned tasks in parallel up to maxConcurrency
   * 3. On completion, the graph automatically unblocks dependents
   * 4. Repeat until no more progress is possible
   */
  async run(): Promise<OrchestratorResult> {
    const startTime = Date.now();

    if (this.graph.hasCycle()) {
      throw new Error('Task graph contains a cycle — cannot execute');
    }

    this.emitEvent('orchestration_started');

    const maxConcurrency = this.config.team.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    const members = this.config.team.members;

    await this.executeQueue(members, maxConcurrency);

    const result: OrchestratorResult = {
      taskGraph: this.graph.getResult(),
      agentResults: new Map(this.agentResults),
      sharedMemory: new Map(this.sharedMemory),
      success: this.graph.getResult().success,
      durationMs: Date.now() - startTime,
    };

    this.emitEvent('orchestration_completed', undefined, undefined, result);
    return result;
  }

  /** Build a prompt for a task, injecting shared memory from completed dependencies. */
  buildTaskPrompt(task: OrchestrationTask): string {
    const lines: string[] = [
      `# Task: ${task.title}`,
      '',
      task.description,
    ];

    // Inject results from dependency tasks
    if (task.dependsOn.length > 0) {
      const depResults: string[] = [];
      for (const depId of task.dependsOn) {
        const depTask = this.graph.getTask(depId);
        const output = this.sharedMemory.get(`task:${depId}:result`);
        if (depTask && output) {
          depResults.push(`## Result from "${depTask.title}"\n${output}`);
        }
      }
      if (depResults.length > 0) {
        lines.push('', '---', '', '# Context from prior tasks', '', ...depResults);
      }
    }

    // Inject task input if present
    if (task.input && Object.keys(task.input).length > 0) {
      lines.push('', '# Task Input', '', JSON.stringify(task.input, null, 2));
    }

    return lines.join('\n');
  }

  // ── Private Execution Loop ──

  private async executeQueue(
    members: TeamMember[],
    maxConcurrency: number,
  ): Promise<void> {
    while (true) {
      // Auto-assign unassigned pending tasks
      this.scheduler.autoAssign(this.graph, members);

      const ready = this.graph.getByStatus('assigned');
      if (ready.length === 0) {
        // Check if stuck (blocked tasks remain but no progress possible)
        if (this.graph.isTerminal() || this.graph.isStuck()) {
          break;
        }
        // Also break if nothing is running or ready
        const running = this.graph.getByStatus('running');
        if (running.length === 0) break;
      }

      // Dispatch in batches up to maxConcurrency
      const batch = ready.slice(0, maxConcurrency);
      const dispatches = batch.map((task) => this.dispatchTask(task, members));

      await Promise.all(dispatches);
    }
  }

  private async dispatchTask(
    task: OrchestrationTask,
    members: TeamMember[],
  ): Promise<void> {
    const assigneeId = task.assigneeId;
    if (!assigneeId) {
      this.graph.fail(task.id, 'No agent assigned to task');
      this.emitEvent('task_failed', task.id, undefined, 'No agent assigned');
      return;
    }

    const member = members.find((m) => m.definition.id === assigneeId);
    if (!member) {
      this.graph.fail(task.id, `Agent "${assigneeId}" not found in team`);
      this.emitEvent('task_failed', task.id, assigneeId, `Agent not found`);
      return;
    }

    // Mark running
    this.graph.markRunning(task.id);
    this.scheduler.recordStart(assigneeId);
    this.emitEvent('task_started', task.id, assigneeId);

    const prompt = this.buildTaskPrompt(task);

    try {
      const runtimeOptions = this.mergeRuntimeOptions(member);
      const result = await this.executor(member, prompt, runtimeOptions);

      this.agentResults.set(`${assigneeId}:${task.id}`, result);

      if (result.output) {
        // Store in shared memory
        this.sharedMemory.set(`task:${task.id}:result`, result.output);
        this.graph.complete(task.id, result.output);
        this.emitEvent('task_completed', task.id, assigneeId);
      } else {
        const error = result.run?.error ?? 'Agent produced no output';
        this.graph.fail(task.id, error);
        this.emitEvent('task_failed', task.id, assigneeId, error);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.graph.fail(task.id, message);
      this.emitEvent('task_failed', task.id, assigneeId, message);
    } finally {
      this.scheduler.recordFinish(assigneeId);
    }
  }

  private mergeRuntimeOptions(member: TeamMember): Partial<RuntimeOptions> {
    return {
      ...this.config.defaultRuntimeOptions,
      ...member.runtimeOptions,
    };
  }

  /** Default executor: creates a real AgentRuntime and runs the prompt. */
  private async defaultExecutor(
    member: TeamMember,
    prompt: string,
    runtimeOptions?: Partial<RuntimeOptions>,
  ): Promise<RunResult> {
    const runtime = new AgentRuntime(member.definition, runtimeOptions as RuntimeOptions);
    return runtime.run(prompt);
  }

  private emitEvent(
    type: OrchestratorEvent['type'],
    taskId?: string,
    agentId?: string,
    data?: unknown,
  ): void {
    this.config.onProgress?.({
      type,
      taskId,
      agentId,
      data,
      timestamp: Date.now(),
    });
  }
}
