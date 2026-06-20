/**
 * @module Scheduler
 * @description
 * Capability-aware task-to-agent assignment for multi-agent orchestration.
 *
 * Supports multiple strategies:
 * - round-robin: distribute tasks evenly across available agents
 * - capability-match: assign based on advertised capabilities
 * - least-busy: assign to the agent with the fewest in-flight tasks
 */

import type { TaskGraph } from './TaskGraph';
import type {
  OrchestrationTask,
  SchedulerConfig,
  SchedulerStrategy,
  TeamMember,
} from './types';

export class Scheduler {
  private readonly strategy: SchedulerStrategy;
  private roundRobinIndex = 0;
  private readonly inFlightCounts: Map<string, number> = new Map();

  constructor(config?: SchedulerConfig) {
    this.strategy = config?.strategy ?? 'capability-match';
  }

  /**
   * Auto-assign all unassigned pending tasks in the graph.
   * Returns the number of tasks assigned.
   */
  autoAssign(graph: TaskGraph, members: TeamMember[]): number {
    if (members.length === 0) return 0;

    const pending = graph.getByStatus('pending').filter((t) => !t.assigneeId);
    let assigned = 0;

    for (const task of pending) {
      const member = this.selectMember(task, members);
      if (member) {
        graph.assign(task.id, member.definition.id);
        assigned++;
      }
    }

    return assigned;
  }

  /** Record that an agent started a task (for least-busy tracking). */
  recordStart(agentId: string): void {
    this.inFlightCounts.set(agentId, (this.inFlightCounts.get(agentId) ?? 0) + 1);
  }

  /** Record that an agent finished a task (for least-busy tracking). */
  recordFinish(agentId: string): void {
    const current = this.inFlightCounts.get(agentId) ?? 0;
    this.inFlightCounts.set(agentId, Math.max(0, current - 1));
  }

  /** Select the best member for a task based on the configured strategy. */
  private selectMember(
    task: OrchestrationTask,
    members: TeamMember[],
  ): TeamMember | undefined {
    if (members.length === 0) return undefined;

    switch (this.strategy) {
      case 'capability-match':
        return this.selectByCapability(task, members);
      case 'least-busy':
        return this.selectLeastBusy(members);
      case 'round-robin':
        return this.selectRoundRobin(members);
      default:
        return members[0];
    }
  }

  /** Match task metadata/title against member capabilities. Falls back to round-robin. */
  private selectByCapability(
    task: OrchestrationTask,
    members: TeamMember[],
  ): TeamMember | undefined {
    // Check task metadata for required capabilities
    const required = task.metadata?.requiredCapabilities as string[] | undefined;

    if (required && required.length > 0) {
      const matched = members.filter((m) =>
        required.every((cap) => m.capabilities?.includes(cap)),
      );
      if (matched.length > 0) {
        return this.selectLeastBusy(matched);
      }
    }

    // Fall back to first member whose capabilities overlap with task title words
    const titleWords = task.title.toLowerCase().split(/\s+/);
    const scored = members.map((m) => {
      const caps = m.capabilities ?? [];
      const score = caps.filter((c) =>
        titleWords.some((w) => w.includes(c.toLowerCase()) || c.toLowerCase().includes(w)),
      ).length;
      return { member: m, score };
    });

    const best = scored.sort((a, b) => b.score - a.score);
    if (best[0] && best[0].score > 0) {
      return best[0].member;
    }

    // No capability match — fall back to round-robin
    return this.selectRoundRobin(members);
  }

  /** Select the member with the fewest in-flight tasks. */
  private selectLeastBusy(members: TeamMember[]): TeamMember | undefined {
    let best: TeamMember | undefined;
    let bestCount = Infinity;

    for (const member of members) {
      const count = this.inFlightCounts.get(member.definition.id) ?? 0;
      if (count < bestCount) {
        bestCount = count;
        best = member;
      }
    }

    return best;
  }

  /** Simple round-robin across members. */
  private selectRoundRobin(members: TeamMember[]): TeamMember | undefined {
    if (members.length === 0) return undefined;
    const member = members[this.roundRobinIndex % members.length];
    this.roundRobinIndex++;
    return member;
  }
}
