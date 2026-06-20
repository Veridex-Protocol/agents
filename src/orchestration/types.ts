/**
 * @module OrchestrationTypes
 * @description
 * Type definitions for the Veridex multi-agent orchestration layer.
 *
 * Provides durable task decomposition, dependency-aware scheduling,
 * explicit handoff contracts, and shared-state coordination between
 * multiple AgentRuntime instances.
 */

import type { AgentDefinition, RuntimeOptions } from '../types/agent';
import type { RunResult } from '../types/runtime';

// ── Task Types ──

/** Lifecycle states of an orchestration task. */
export type OrchestrationTaskStatus =
  | 'pending'
  | 'blocked'
  | 'assigned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Priority levels for orchestration tasks. */
export type OrchestrationTaskPriority = 'critical' | 'high' | 'normal' | 'low';

/** A task within the orchestration graph. */
export interface OrchestrationTask {
  /** Unique task identifier */
  id: string;
  /** Task title */
  title: string;
  /** Task description / prompt for the assigned agent */
  description: string;
  /** Current status */
  status: OrchestrationTaskStatus;
  /** Priority level */
  priority: OrchestrationTaskPriority;
  /** Agent ID assigned to execute this task */
  assigneeId?: string;
  /** Task IDs that must complete before this task can run */
  dependsOn: string[];
  /** Input data for the task */
  input?: Record<string, unknown>;
  /** Output produced by the task */
  output?: string;
  /** Error message if failed */
  error?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Completion timestamp */
  completedAt?: number;
}

/** Options for creating a new orchestration task. */
export interface CreateOrchestrationTaskOptions {
  /** Task title */
  title: string;
  /** Task description / prompt */
  description: string;
  /** Priority level */
  priority?: OrchestrationTaskPriority;
  /** Agent ID to assign */
  assigneeId?: string;
  /** Task IDs this task depends on */
  dependsOn?: string[];
  /** Input data */
  input?: Record<string, unknown>;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

// ── Task Graph ──

/** The result of a task graph execution. */
export interface TaskGraphResult {
  /** All tasks in the graph */
  tasks: OrchestrationTask[];
  /** Tasks that completed successfully */
  completed: OrchestrationTask[];
  /** Tasks that failed */
  failed: OrchestrationTask[];
  /** Tasks that remain blocked (due to failed dependencies) */
  blocked: OrchestrationTask[];
  /** Tasks that were cancelled */
  cancelled: OrchestrationTask[];
  /** Whether all tasks completed successfully */
  success: boolean;
}

// ── Team Types ──

/** Configuration for a team member agent. */
export interface TeamMember {
  /** Agent definition */
  definition: AgentDefinition;
  /** Runtime options for this member's runtime */
  runtimeOptions?: Partial<RuntimeOptions>;
  /** Capabilities this member advertises (for scheduler matching) */
  capabilities?: string[];
}

/** Configuration for a multi-agent team. */
export interface TeamConfig {
  /** Unique team identifier */
  id: string;
  /** Team name */
  name: string;
  /** Team member agents */
  members: TeamMember[];
  /** Maximum concurrent agent executions */
  maxConcurrency?: number;
  /** Whether to enable shared memory across team members */
  sharedMemory?: boolean;
}

// ── Scheduler Types ──

/** Strategy for assigning tasks to agents. */
export type SchedulerStrategy =
  | 'round-robin'
  | 'capability-match'
  | 'least-busy';

/** Scheduler configuration. */
export interface SchedulerConfig {
  /** Assignment strategy */
  strategy: SchedulerStrategy;
}

// ── Orchestrator Types ──

/** Events emitted during orchestration for progress tracking. */
export interface OrchestratorEvent {
  /** Event type */
  type:
    | 'task_created'
    | 'task_assigned'
    | 'task_started'
    | 'task_completed'
    | 'task_failed'
    | 'task_blocked'
    | 'task_cancelled'
    | 'orchestration_started'
    | 'orchestration_completed'
    | 'error';
  /** Task ID (when applicable) */
  taskId?: string;
  /** Agent ID (when applicable) */
  agentId?: string;
  /** Event data */
  data?: unknown;
  /** Timestamp */
  timestamp: number;
}

/** Configuration for the orchestrator. */
export interface OrchestratorConfig {
  /** Team configuration */
  team: TeamConfig;
  /** Scheduler strategy */
  schedulerStrategy?: SchedulerStrategy;
  /** Progress callback */
  onProgress?: (event: OrchestratorEvent) => void;
  /** Default runtime options applied to all team member runtimes */
  defaultRuntimeOptions?: Partial<RuntimeOptions>;
}

/** Result of an orchestrator run. */
export interface OrchestratorResult {
  /** Task graph execution result */
  taskGraph: TaskGraphResult;
  /** Per-agent run results keyed by `agentId:taskId` */
  agentResults: Map<string, RunResult>;
  /** Shared memory entries produced during orchestration */
  sharedMemory: Map<string, string>;
  /** Whether all tasks succeeded */
  success: boolean;
  /** Orchestration duration in milliseconds */
  durationMs: number;
}

/** Agent executor function — allows swapping real runtimes for test doubles. */
export type AgentExecutor = (
  member: TeamMember,
  prompt: string,
  runtimeOptions?: Partial<RuntimeOptions>,
) => Promise<RunResult>;
