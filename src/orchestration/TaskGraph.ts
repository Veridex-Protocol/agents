/**
 * @module TaskGraph
 * @description
 * Dependency-aware task graph for multi-agent orchestration.
 *
 * Manages a DAG of tasks with lifecycle transitions, dependency tracking,
 * and automatic unblocking when dependencies complete.
 */

import { randomBytes } from 'node:crypto';

import type {
  CreateOrchestrationTaskOptions,
  OrchestrationTask,
  OrchestrationTaskStatus,
  TaskGraphResult,
} from './types';

export class TaskGraph {
  private readonly tasks: Map<string, OrchestrationTask> = new Map();

  /** Add a task to the graph. Returns the created task. */
  addTask(options: CreateOrchestrationTaskOptions): OrchestrationTask {
    const now = Date.now();
    const dependsOn = options.dependsOn ?? [];

    // Validate dependencies exist
    for (const depId of dependsOn) {
      if (!this.tasks.has(depId)) {
        throw new Error(`Dependency task "${depId}" does not exist in the graph`);
      }
    }

    const task: OrchestrationTask = {
      id: `ot_${randomBytes(8).toString('hex')}`,
      title: options.title,
      description: options.description,
      status: dependsOn.length > 0 ? 'blocked' : 'pending',
      priority: options.priority ?? 'normal',
      assigneeId: options.assigneeId,
      dependsOn,
      input: options.input,
      createdAt: now,
      updatedAt: now,
      metadata: options.metadata,
    };

    this.tasks.set(task.id, task);
    return { ...task };
  }

  /** Get a task by ID. */
  getTask(id: string): OrchestrationTask | undefined {
    const task = this.tasks.get(id);
    return task ? { ...task } : undefined;
  }

  /** Get all tasks. */
  getAllTasks(): OrchestrationTask[] {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }

  /** Get tasks matching a given status. */
  getByStatus(status: OrchestrationTaskStatus): OrchestrationTask[] {
    return [...this.tasks.values()]
      .filter((t) => t.status === status)
      .map((t) => ({ ...t }));
  }

  /** Get tasks that are ready to execute (pending + assigned). */
  getReady(): OrchestrationTask[] {
    return [...this.tasks.values()]
      .filter((t) => t.status === 'pending' || t.status === 'assigned')
      .map((t) => ({ ...t }));
  }

  /** Assign a task to an agent. Transitions pending → assigned. */
  assign(taskId: string, agentId: string): OrchestrationTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'pending') {
      throw new Error(`Cannot assign task "${taskId}" in status "${task.status}"`);
    }
    task.assigneeId = agentId;
    task.status = 'assigned';
    task.updatedAt = Date.now();
    return { ...task };
  }

  /** Mark a task as running. Transitions assigned → running. */
  markRunning(taskId: string): OrchestrationTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'assigned' && task.status !== 'pending') {
      throw new Error(`Cannot start task "${taskId}" in status "${task.status}"`);
    }
    task.status = 'running';
    task.updatedAt = Date.now();
    return { ...task };
  }

  /**
   * Mark a task as completed with output.
   * Automatically unblocks dependent tasks whose dependencies are now all met.
   */
  complete(taskId: string, output: string): OrchestrationTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'running') {
      throw new Error(`Cannot complete task "${taskId}" in status "${task.status}"`);
    }
    const now = Date.now();
    task.status = 'completed';
    task.output = output;
    task.updatedAt = now;
    task.completedAt = now;

    this.unblockDependents(taskId);
    return { ...task };
  }

  /** Mark a task as failed. Dependents remain blocked. */
  fail(taskId: string, error: string): OrchestrationTask {
    const task = this.requireTask(taskId);
    task.status = 'failed';
    task.error = error;
    task.updatedAt = Date.now();
    return { ...task };
  }

  /** Cancel a task and cascade-cancel its dependents. */
  cancel(taskId: string): OrchestrationTask[] {
    const cancelled: OrchestrationTask[] = [];
    const task = this.requireTask(taskId);

    if (task.status === 'completed' || task.status === 'failed') {
      return cancelled;
    }

    task.status = 'cancelled';
    task.updatedAt = Date.now();
    cancelled.push({ ...task });

    // Cascade: cancel blocked dependents
    for (const dependent of this.getDependents(taskId)) {
      if (dependent.status === 'blocked') {
        const cascaded = this.cancel(dependent.id);
        cancelled.push(...cascaded);
      }
    }

    return cancelled;
  }

  /** Check if the graph has any cycles. */
  hasCycle(): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (taskId: string): boolean => {
      visited.add(taskId);
      recursionStack.add(taskId);

      const task = this.tasks.get(taskId);
      if (!task) return false;

      for (const depId of task.dependsOn) {
        if (!visited.has(depId)) {
          if (dfs(depId)) return true;
        } else if (recursionStack.has(depId)) {
          return true;
        }
      }

      recursionStack.delete(taskId);
      return false;
    };

    for (const taskId of this.tasks.keys()) {
      if (!visited.has(taskId) && dfs(taskId)) {
        return true;
      }
    }
    return false;
  }

  /** Build the final execution result. */
  getResult(): TaskGraphResult {
    const all = this.getAllTasks();
    return {
      tasks: all,
      completed: all.filter((t) => t.status === 'completed'),
      failed: all.filter((t) => t.status === 'failed'),
      blocked: all.filter((t) => t.status === 'blocked'),
      cancelled: all.filter((t) => t.status === 'cancelled'),
      success: all.every((t) => t.status === 'completed'),
    };
  }

  /** Get the number of tasks in the graph. */
  get size(): number {
    return this.tasks.size;
  }

  /** Check whether all tasks have reached a terminal state. */
  isTerminal(): boolean {
    return [...this.tasks.values()].every(
      (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
    );
  }

  /** Check if there's any forward progress possible. */
  isStuck(): boolean {
    const hasActive = [...this.tasks.values()].some(
      (t) => t.status === 'pending' || t.status === 'assigned' || t.status === 'running',
    );
    if (hasActive) return false;

    // If everything is terminal or blocked, and there are blocked tasks → stuck
    return this.getByStatus('blocked').length > 0;
  }

  // ── Private Helpers ──

  private requireTask(taskId: string): OrchestrationTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found in graph`);
    }
    return task;
  }

  /** Unblock tasks whose dependencies are now all completed. */
  private unblockDependents(completedTaskId: string): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'blocked') continue;
      if (!task.dependsOn.includes(completedTaskId)) continue;

      const allDepsComplete = task.dependsOn.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep?.status === 'completed';
      });

      if (allDepsComplete) {
        task.status = 'pending';
        task.updatedAt = Date.now();
      }
    }
  }

  /** Get tasks that depend on a given task ID. */
  private getDependents(taskId: string): OrchestrationTask[] {
    return [...this.tasks.values()].filter((t) => t.dependsOn.includes(taskId));
  }
}
