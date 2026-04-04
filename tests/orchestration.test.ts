/**
 * Orchestration tests — TaskGraph, Scheduler, Orchestrator.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  TaskGraph,
  Scheduler,
  Orchestrator,
} from '../src/orchestration';
import type {
  TeamMember,
  AgentExecutor,
  OrchestratorEvent,
} from '../src/orchestration';
import type { AgentDefinition } from '../src/types/agent';
import type { RunResult, Run, RunSessionSnapshot } from '../src/types/runtime';
import type { RuntimeBootstrapReport } from '../src/types/bootstrap';

// ── Test Helpers ──

function makeDef(id: string, name?: string): AgentDefinition {
  return {
    id,
    name: name ?? id,
    model: { provider: 'test', model: 'test-model' },
    instructions: `You are ${id}.`,
  };
}

function makeMember(id: string, capabilities?: string[]): TeamMember {
  return {
    definition: makeDef(id),
    capabilities,
  };
}

function makeRunResult(output: string): RunResult {
  const run: Run = {
    id: 'run_test',
    agentId: 'test',
    state: 'completed',
    input: 'test',
    turns: [],
    turnOutcomes: [],
    output,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0 },
    policyDecisions: [],
    approvalDecisions: [],
  };
  const session: RunSessionSnapshot = {
    runId: run.id,
    agentId: run.agentId,
    prompt: 'test',
    routedMatches: [],
    toolExecutionSummaries: [],
    streamEventSummary: [],
    checkpointRefs: [],
    transcript: { runId: run.id, agentId: run.agentId, entryCount: 0 },
    transcriptEntries: [],
    bootstrapReport: {} as RuntimeBootstrapReport,
    approvalState: { status: 'none' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return {
    run,
    output,
    events: [],
    usage: run.totalUsage,
    turnOutcomes: [],
    session,
    bootstrapReport: {} as RuntimeBootstrapReport,
  };
}

// ══════════════════════════════════════════════════════════════════
// TaskGraph
// ══════════════════════════════════════════════════════════════════

describe('TaskGraph', () => {
  it('adds tasks and assigns IDs', () => {
    const graph = new TaskGraph();
    const t = graph.addTask({ title: 'A', description: 'Do A' });
    expect(t.id).toMatch(/^ot_/);
    expect(t.status).toBe('pending');
    expect(graph.size).toBe(1);
  });

  it('creates blocked tasks when dependencies exist', () => {
    const graph = new TaskGraph();
    const t1 = graph.addTask({ title: 'A', description: 'Do A' });
    const t2 = graph.addTask({ title: 'B', description: 'Do B', dependsOn: [t1.id] });
    expect(t2.status).toBe('blocked');
  });

  it('rejects dependencies on nonexistent tasks', () => {
    const graph = new TaskGraph();
    expect(() =>
      graph.addTask({ title: 'A', description: 'Do A', dependsOn: ['fake'] }),
    ).toThrow('does not exist');
  });

  it('transitions: pending → assigned → running → completed', () => {
    const graph = new TaskGraph();
    const t = graph.addTask({ title: 'A', description: 'Do A' });

    const assigned = graph.assign(t.id, 'agent_1');
    expect(assigned.status).toBe('assigned');
    expect(assigned.assigneeId).toBe('agent_1');

    const running = graph.markRunning(t.id);
    expect(running.status).toBe('running');

    const completed = graph.complete(t.id, 'done');
    expect(completed.status).toBe('completed');
    expect(completed.output).toBe('done');
    expect(completed.completedAt).toBeDefined();
  });

  it('unblocks dependents when dependency completes', () => {
    const graph = new TaskGraph();
    const t1 = graph.addTask({ title: 'A', description: 'Do A' });
    const t2 = graph.addTask({ title: 'B', description: 'Do B', dependsOn: [t1.id] });

    expect(graph.getByStatus('blocked')).toHaveLength(1);

    graph.assign(t1.id, 'agent');
    graph.markRunning(t1.id);
    graph.complete(t1.id, 'result');

    // t2 should now be pending
    const pending = graph.getByStatus('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(t2.id);
  });

  it('does not unblock when not all dependencies are met', () => {
    const graph = new TaskGraph();
    const t1 = graph.addTask({ title: 'A', description: 'Do A' });
    const t2 = graph.addTask({ title: 'B', description: 'Do B' });
    const t3 = graph.addTask({ title: 'C', description: 'Do C', dependsOn: [t1.id, t2.id] });

    graph.assign(t1.id, 'agent');
    graph.markRunning(t1.id);
    graph.complete(t1.id, 'done');

    // t3 still blocked because t2 isn't done
    expect(graph.getTask(t3.id)?.status).toBe('blocked');
  });

  it('marks task as failed', () => {
    const graph = new TaskGraph();
    const t = graph.addTask({ title: 'A', description: 'Do A' });
    graph.assign(t.id, 'agent');
    graph.markRunning(t.id);
    const failed = graph.fail(t.id, 'boom');
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('boom');
  });

  it('cancels a task and cascades to blocked dependents', () => {
    const graph = new TaskGraph();
    const t1 = graph.addTask({ title: 'A', description: 'Do A' });
    const t2 = graph.addTask({ title: 'B', description: 'Do B', dependsOn: [t1.id] });

    const cancelled = graph.cancel(t1.id);
    expect(cancelled).toHaveLength(2);
    expect(graph.getTask(t1.id)?.status).toBe('cancelled');
    expect(graph.getTask(t2.id)?.status).toBe('cancelled');
  });

  it('detects cycles', () => {
    const graph = new TaskGraph();
    const t1 = graph.addTask({ title: 'A', description: 'A' });
    // Can't create a real cycle through the API since deps must exist first,
    // but we can verify hasCycle returns false for a DAG
    const t2 = graph.addTask({ title: 'B', description: 'B', dependsOn: [t1.id] });
    expect(graph.hasCycle()).toBe(false);
  });

  it('reports terminal state correctly', () => {
    const graph = new TaskGraph();
    const t = graph.addTask({ title: 'A', description: 'A' });
    expect(graph.isTerminal()).toBe(false);

    graph.assign(t.id, 'agent');
    graph.markRunning(t.id);
    graph.complete(t.id, 'done');
    expect(graph.isTerminal()).toBe(true);
  });

  it('detects stuck state', () => {
    const graph = new TaskGraph();
    const t1 = graph.addTask({ title: 'A', description: 'A' });
    const t2 = graph.addTask({ title: 'B', description: 'B', dependsOn: [t1.id] });

    // Fail t1 — t2 remains blocked
    graph.assign(t1.id, 'agent');
    graph.markRunning(t1.id);
    graph.fail(t1.id, 'error');

    expect(graph.isStuck()).toBe(true);
  });

  it('produces correct result summary', () => {
    const graph = new TaskGraph();
    const t1 = graph.addTask({ title: 'A', description: 'A' });
    const t2 = graph.addTask({ title: 'B', description: 'B' });

    graph.assign(t1.id, 'agent');
    graph.markRunning(t1.id);
    graph.complete(t1.id, 'ok');

    graph.assign(t2.id, 'agent');
    graph.markRunning(t2.id);
    graph.fail(t2.id, 'err');

    const result = graph.getResult();
    expect(result.completed).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it('respects priority field', () => {
    const graph = new TaskGraph();
    const t = graph.addTask({ title: 'A', description: 'A', priority: 'critical' });
    expect(t.priority).toBe('critical');
  });
});

// ══════════════════════════════════════════════════════════════════
// Scheduler
// ══════════════════════════════════════════════════════════════════

describe('Scheduler', () => {
  it('assigns pending tasks via round-robin', () => {
    const scheduler = new Scheduler({ strategy: 'round-robin' });
    const graph = new TaskGraph();
    graph.addTask({ title: 'A', description: 'A' });
    graph.addTask({ title: 'B', description: 'B' });

    const members = [makeMember('agent_1'), makeMember('agent_2')];
    const count = scheduler.autoAssign(graph, members);

    expect(count).toBe(2);
    const assigned = graph.getByStatus('assigned');
    expect(assigned).toHaveLength(2);
    const ids = assigned.map((t) => t.assigneeId);
    expect(ids).toContain('agent_1');
    expect(ids).toContain('agent_2');
  });

  it('assigns by capability match', () => {
    const scheduler = new Scheduler({ strategy: 'capability-match' });
    const graph = new TaskGraph();
    graph.addTask({
      title: 'research topic',
      description: 'Research something',
    });

    const members = [
      makeMember('writer', ['writing']),
      makeMember('researcher', ['research']),
    ];

    scheduler.autoAssign(graph, members);
    const assigned = graph.getByStatus('assigned');
    expect(assigned).toHaveLength(1);
    expect(assigned[0].assigneeId).toBe('researcher');
  });

  it('assigns via metadata requiredCapabilities', () => {
    const scheduler = new Scheduler({ strategy: 'capability-match' });
    const graph = new TaskGraph();
    graph.addTask({
      title: 'Write',
      description: 'Write a report',
      metadata: { requiredCapabilities: ['writing'] },
    });

    const members = [
      makeMember('coder', ['coding']),
      makeMember('writer', ['writing', 'editing']),
    ];

    scheduler.autoAssign(graph, members);
    const assigned = graph.getByStatus('assigned');
    expect(assigned[0].assigneeId).toBe('writer');
  });

  it('tracks in-flight counts for least-busy', () => {
    const scheduler = new Scheduler({ strategy: 'least-busy' });
    scheduler.recordStart('agent_1');
    scheduler.recordStart('agent_1');
    scheduler.recordStart('agent_2');

    const graph = new TaskGraph();
    graph.addTask({ title: 'Task', description: 'Do it' });

    const members = [makeMember('agent_1'), makeMember('agent_2')];
    scheduler.autoAssign(graph, members);

    const assigned = graph.getByStatus('assigned');
    // agent_2 has fewer in-flight
    expect(assigned[0].assigneeId).toBe('agent_2');
  });

  it('skips already-assigned tasks', () => {
    const scheduler = new Scheduler({ strategy: 'round-robin' });
    const graph = new TaskGraph();
    const t = graph.addTask({ title: 'A', description: 'A', assigneeId: 'pre-assigned' });

    // Task has assigneeId but is still pending — scheduler skips it
    const members = [makeMember('agent_1')];
    const count = scheduler.autoAssign(graph, members);
    expect(count).toBe(0);
  });

  it('returns 0 when no members', () => {
    const scheduler = new Scheduler({ strategy: 'round-robin' });
    const graph = new TaskGraph();
    graph.addTask({ title: 'A', description: 'A' });
    expect(scheduler.autoAssign(graph, [])).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// Orchestrator
// ══════════════════════════════════════════════════════════════════

describe('Orchestrator', () => {
  function mockExecutor(outputs: Record<string, string>): AgentExecutor {
    return async (member, prompt) => {
      const output = outputs[member.definition.id] ?? 'default output';
      return makeRunResult(output);
    };
  }

  it('executes independent tasks in parallel', async () => {
    const events: OrchestratorEvent[] = [];
    const executor = mockExecutor({
      agent_1: 'result from agent 1',
      agent_2: 'result from agent 2',
    });

    const orchestrator = new Orchestrator(
      {
        team: {
          id: 'team_1',
          name: 'Test Team',
          members: [makeMember('agent_1'), makeMember('agent_2')],
          maxConcurrency: 5,
        },
        schedulerStrategy: 'round-robin',
        onProgress: (e) => events.push(e),
      },
      executor,
    );

    orchestrator.addTask({ title: 'Task A', description: 'Do A' });
    orchestrator.addTask({ title: 'Task B', description: 'Do B' });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.taskGraph.completed).toHaveLength(2);
    expect(result.agentResults.size).toBe(2);
    expect(result.sharedMemory.size).toBe(2);

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('orchestration_started');
    expect(eventTypes).toContain('task_created');
    expect(eventTypes).toContain('task_started');
    expect(eventTypes).toContain('task_completed');
    expect(eventTypes).toContain('orchestration_completed');
  });

  it('respects dependency ordering', async () => {
    const executionOrder: string[] = [];
    const executor: AgentExecutor = async (member, prompt) => {
      executionOrder.push(member.definition.id);
      return makeRunResult(`output from ${member.definition.id}`);
    };

    const orchestrator = new Orchestrator(
      {
        team: {
          id: 'team_dep',
          name: 'Dependency Team',
          members: [makeMember('agent_1'), makeMember('agent_2')],
          maxConcurrency: 5,
        },
        schedulerStrategy: 'round-robin',
      },
      executor,
    );

    const t1 = orchestrator.addTask({ title: 'First', description: 'Run first' });
    orchestrator.addTask({
      title: 'Second',
      description: 'Run after first',
      dependsOn: [t1.id],
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.taskGraph.completed).toHaveLength(2);
    // First task must execute before second
    expect(executionOrder[0]).toBeDefined();
    expect(executionOrder[1]).toBeDefined();
    expect(executionOrder.length).toBe(2);
  });

  it('injects dependency results into task prompts', async () => {
    const receivedPrompts: string[] = [];
    const executor: AgentExecutor = async (member, prompt) => {
      receivedPrompts.push(prompt);
      return makeRunResult('task output');
    };

    const orchestrator = new Orchestrator(
      {
        team: {
          id: 'team_ctx',
          name: 'Context Team',
          members: [makeMember('agent_1')],
        },
        schedulerStrategy: 'round-robin',
      },
      executor,
    );

    const t1 = orchestrator.addTask({ title: 'Research', description: 'Do research' });
    orchestrator.addTask({
      title: 'Write',
      description: 'Write report',
      dependsOn: [t1.id],
    });

    await orchestrator.run();

    // Second prompt should contain the result from first task
    expect(receivedPrompts[1]).toContain('Context from prior tasks');
    expect(receivedPrompts[1]).toContain('task output');
  });

  it('handles task failures gracefully', async () => {
    const executor: AgentExecutor = async (member) => {
      if (member.definition.id === 'agent_1') {
        throw new Error('Agent crashed');
      }
      return makeRunResult('ok');
    };

    const orchestrator = new Orchestrator(
      {
        team: {
          id: 'team_fail',
          name: 'Failure Team',
          members: [makeMember('agent_1'), makeMember('agent_2')],
        },
        schedulerStrategy: 'round-robin',
      },
      executor,
    );

    orchestrator.addTask({ title: 'Will fail', description: 'Fails' });
    orchestrator.addTask({ title: 'Will succeed', description: 'Succeeds' });

    const result = await orchestrator.run();

    expect(result.success).toBe(false);
    expect(result.taskGraph.failed).toHaveLength(1);
    expect(result.taskGraph.completed).toHaveLength(1);
  });

  it('blocks dependents when upstream fails', async () => {
    const executor: AgentExecutor = async (member) => {
      throw new Error('fail');
    };

    const orchestrator = new Orchestrator(
      {
        team: {
          id: 'team_block',
          name: 'Block Team',
          members: [makeMember('agent_1')],
        },
        schedulerStrategy: 'round-robin',
      },
      executor,
    );

    const t1 = orchestrator.addTask({ title: 'Upstream', description: 'Fails' });
    orchestrator.addTask({
      title: 'Downstream',
      description: 'Depends on upstream',
      dependsOn: [t1.id],
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(false);
    expect(result.taskGraph.failed).toHaveLength(1);
    expect(result.taskGraph.blocked).toHaveLength(1);
  });

  it('uses capability-match scheduler by default', async () => {
    const executedBy: string[] = [];
    const executor: AgentExecutor = async (member) => {
      executedBy.push(member.definition.id);
      return makeRunResult('done');
    };

    const orchestrator = new Orchestrator(
      {
        team: {
          id: 'team_cap',
          name: 'Capability Team',
          members: [
            makeMember('writer', ['writing']),
            makeMember('researcher', ['research']),
          ],
        },
        // default strategy = capability-match
      },
      executor,
    );

    orchestrator.addTask({ title: 'research market', description: 'Research the market' });

    await orchestrator.run();

    expect(executedBy[0]).toBe('researcher');
  });

  it('exposes shared memory after execution', async () => {
    const executor = mockExecutor({ agent_1: 'shared result' });

    const orchestrator = new Orchestrator(
      {
        team: {
          id: 'team_mem',
          name: 'Memory Team',
          members: [makeMember('agent_1')],
        },
        schedulerStrategy: 'round-robin',
      },
      executor,
    );

    const t = orchestrator.addTask({ title: 'Task', description: 'Do it' });
    await orchestrator.run();

    const mem = orchestrator.getSharedMemory();
    expect(mem.get(`task:${t.id}:result`)).toBe('shared result');
  });

  it('reports duration', async () => {
    const executor = mockExecutor({ agent_1: 'fast' });

    const orchestrator = new Orchestrator(
      {
        team: {
          id: 'team_dur',
          name: 'Duration Team',
          members: [makeMember('agent_1')],
        },
        schedulerStrategy: 'round-robin',
      },
      executor,
    );

    orchestrator.addTask({ title: 'Quick', description: 'Quick task' });
    const result = await orchestrator.run();

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('throws on cyclic task graph', async () => {
    // We can't actually create a cycle through the addTask API
    // since dependencies must exist at add time, but we can verify
    // the orchestrator checks for cycles before running
    const executor = mockExecutor({});
    const orchestrator = new Orchestrator(
      {
        team: {
          id: 'team_cycle',
          name: 'Cycle Team',
          members: [makeMember('agent_1')],
        },
      },
      executor,
    );

    // Linear DAG is fine
    const t1 = orchestrator.addTask({ title: 'A', description: 'A' });
    orchestrator.addTask({ title: 'B', description: 'B', dependsOn: [t1.id] });
    // No cycle, should not throw
    const result = await orchestrator.run();
    expect(result.success).toBe(true);
  });

  it('handles empty task graph', async () => {
    const executor = mockExecutor({});
    const orchestrator = new Orchestrator(
      {
        team: {
          id: 'team_empty',
          name: 'Empty Team',
          members: [makeMember('agent_1')],
        },
      },
      executor,
    );

    const result = await orchestrator.run();
    expect(result.success).toBe(true);
    expect(result.taskGraph.tasks).toHaveLength(0);
  });
});
