/**
 * @module orchestration
 * @description
 * Multi-agent orchestration layer for the Veridex Agent Fabric.
 *
 * Provides dependency-aware task graphs, capability-based scheduling,
 * and coordinated multi-agent execution on top of the AgentRuntime kernel.
 */

export { TaskGraph } from './TaskGraph';
export { Scheduler } from './Scheduler';
export { Orchestrator } from './Orchestrator';
export type {
  // Task types
  OrchestrationTask,
  OrchestrationTaskStatus,
  OrchestrationTaskPriority,
  CreateOrchestrationTaskOptions,
  TaskGraphResult,
  // Team types
  TeamMember,
  TeamConfig,
  // Scheduler types
  SchedulerStrategy,
  SchedulerConfig,
  // Orchestrator types
  OrchestratorEvent,
  OrchestratorConfig,
  OrchestratorResult,
  AgentExecutor,
} from './types';
