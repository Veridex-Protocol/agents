/**
 * @module SubagentTools
 * @description
 * Tools that let an agent delegate work to other agents mid-turn.
 *
 * Provides `delegate_task` — a tool the model can invoke to spawn a
 * child AgentRuntime, wait for completion, and receive the result
 * inline.  This is the Veridex equivalent (and improvement upon)
 * DeepAgents' SubagentMiddleware `spawn_agent` / `task` tools.
 *
 * Improvements over DeepAgents:
 * - Typed `AgentDefinition` for each subagent (not raw dicts)
 * - Policy-governed delegation (safety class enforcement)
 * - Trace correlation: child run events are linked to parent run
 * - Timeout + cancellation support via ToolExecutor
 * - Uses existing Orchestrator for multi-step DAG delegation
 */

import { z } from 'zod';
import type { ToolContract, ToolResult } from '../types/tools';
import type { AgentDefinition, RuntimeOptions } from '../types/agent';
import type { MandateCredential } from '../credentials/MandateCredential';
import type { DelegationGuard, DelegationRequest } from '../credentials/DelegationGuard';
import { tool } from './tool';

// ── Types ──

/** A named subagent that can be delegated to. */
export interface SubagentEntry {
  /** Unique name used by the model to reference this subagent. */
  name: string;
  /** Human-readable description of this subagent's capabilities. */
  description: string;
  /** Full agent definition used to spawn the runtime. */
  definition: AgentDefinition;
  /** Runtime options override for this subagent. */
  runtimeOptions?: Partial<RuntimeOptions>;
}

/**
 * Type for the executor function that actually runs the subagent.
 * Decoupled from AgentRuntime to allow test doubles and remote execution.
 */
export type SubagentExecutor = (
  definition: AgentDefinition,
  prompt: string,
  runtimeOptions?: Partial<RuntimeOptions>,
) => Promise<{
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}>;

export interface SubagentToolsOptions {
  /** Available subagents the model can delegate to. */
  agents: SubagentEntry[];
  /**
   * Executor function.  If omitted, delegation will use a default
   * implementation that imports and runs AgentRuntime.  Provide a
   * custom executor for testing or remote execution.
   */
  executor?: SubagentExecutor;
  /** Maximum time (ms) to wait for a subagent to complete (default: 120_000). */
  timeout?: number;
  /** Parent run context for trace correlation. */
  parentContext?: {
    runId: string;
    agentId: string;
    turnIndex: number;
  };
  /**
   * Optional confused-deputy enforcement at the delegation boundary.
   *
   * When provided, every `delegate_task` call must first be authorized by the
   * {@link DelegationGuard}: the parent mandate is cryptographically verified,
   * the requested scope is attenuated against it (a child can never exceed the
   * parent's authority), delegation depth is enforced, and a freshly signed,
   * short-lived child mandate is minted and handed to the subagent runtime via
   * {@link RuntimeOptions.mandate}. If authorization fails, delegation is
   * **denied** and the subagent never runs.
   */
  delegation?: DelegationEnforcement;
}

/** Confused-deputy enforcement configuration for {@link createSubagentTools}. */
export interface DelegationEnforcement {
  /** Guard that verifies + attenuates the mandate on each delegation. */
  guard: DelegationGuard;
  /** The delegating (parent) agent's signed mandate. */
  parentMandate: MandateCredential;
  /** Issuer DID/identifier stamped on issued child mandates. */
  issuer: string;
  /**
   * Resolve the scope and concrete action requested for a specific subagent
   * delegation. The returned scope is *requested* — the guard still attenuates
   * it against the parent mandate, so it can only narrow authority.
   */
  scopeFor?: (
    entry: SubagentEntry,
    input: { task: string; context?: string },
  ) => {
    requestedScope?: DelegationRequest['requestedScope'];
    action?: DelegationRequest['action'];
    ttlMs?: number;
  };
  /** Generate the id for an issued child mandate (default: random UUID urn). */
  mandateId?: () => string;
}

// ── Default executor ──

async function defaultExecutor(
  definition: AgentDefinition,
  prompt: string,
  runtimeOptions?: Partial<RuntimeOptions>,
): Promise<{ success: boolean; output: string; error?: string; metadata?: Record<string, unknown> }> {
  // Lazy import to avoid circular dependencies
  const { AgentRuntime } = await import('../runtime/AgentRuntime');
  const runtime = new AgentRuntime(definition, runtimeOptions);
  const result = await runtime.run(prompt);

  return {
    success: result.run.state === 'completed',
    output: result.output,
    error: result.run.state === 'failed' ? result.run.error : undefined,
    metadata: {
      runId: result.run.id,
      turns: result.run.turns.length,
      state: result.run.state,
    },
  };
}

// ── Factory ──

/**
 * Create the `delegate_task` tool that lets an agent spawn subagents mid-turn.
 *
 * The model sees a list of available agents (name + description) in the tool
 * schema and selects one by name.  The executor spawns a child runtime, waits
 * for completion, and returns the result as the tool output.
 *
 * @example
 * ```ts
 * const delegateTool = createSubagentTools({
 *   agents: [
 *     {
 *       name: 'researcher',
 *       description: 'Searches the web and summarizes findings.',
 *       definition: researcherDef,
 *     },
 *     {
 *       name: 'coder',
 *       description: 'Writes and edits code.',
 *       definition: coderDef,
 *     },
 *   ],
 * });
 *
 * const agent = createAgent({
 *   tools: [delegateTool, ...otherTools],
 * });
 * ```
 */
export function createSubagentTools(
  options: SubagentToolsOptions,
): ToolContract {
  const {
    agents,
    executor = defaultExecutor,
    timeout = 120_000,
    parentContext,
    delegation,
  } = options;

  const agentNames = agents.map((a) => a.name);
  const agentDescriptions = agents
    .map((a) => `- **${a.name}**: ${a.description}`)
    .join('\n');

  const DelegateInput = z.object({
    agent: z
      .string()
      .describe(
        `Name of the subagent to delegate to. Available agents:\n${agentDescriptions}`,
      )
      .refine((name) => agentNames.includes(name), {
        message: `Agent must be one of: ${agentNames.join(', ')}`,
      }),
    task: z.string().describe('Clear, detailed instructions for the subagent.'),
    context: z
      .string()
      .optional()
      .describe('Additional context or data to pass to the subagent.'),
  });

  return tool({
    name: 'delegate_task',
    description:
      'Delegate a task to a specialized subagent.  The subagent runs independently, ' +
      'completes the task, and returns its result.  Use this when a task requires ' +
      'specialized skills or when you want to parallelize work.',
    input: DelegateInput,
    safetyClass: 'write',
    async execute({ input }): Promise<ToolResult> {
      const agent = input.agent as string;
      const task = input.task as string;
      const context = input.context as string | undefined;
      const entry = agents.find((a) => a.name === agent);

      if (!entry) {
        return {
          llmOutput: `Unknown agent: "${agent}". Available: ${agentNames.join(', ')}`,
          success: false,
          error: `Unknown agent: ${agent}`,
        };
      }

      // Build the prompt from task + context
      let prompt = task;
      if (context) {
        prompt = `Context:\n${context}\n\nTask:\n${task}`;
      }

      // Add parent trace correlation
      const runtimeOptions: Partial<RuntimeOptions> = {
        ...entry.runtimeOptions,
      };
      if (parentContext) {
        runtimeOptions.enableTracing = true;
      }

      // Confused-deputy enforcement: verify the parent mandate and mint a
      // scoped, attenuated child mandate before the subagent is allowed to run.
      if (delegation) {
        const scope = delegation.scopeFor?.(entry, { task, context });
        const decision = await delegation.guard.authorizeDelegation({
          parentMandate: delegation.parentMandate,
          delegateAgentId: entry.definition.id ?? entry.name,
          purpose: `delegate_task:${agent}`,
          childMandateId: delegation.mandateId?.() ?? `urn:uuid:${crypto.randomUUID()}`,
          issuer: delegation.issuer,
          requestedScope: scope?.requestedScope,
          action: scope?.action,
          ttlMs: scope?.ttlMs,
        });
        if (!decision.allowed) {
          return {
            llmOutput: `Delegation to "${agent}" was denied by the authority layer: ${decision.reasons.join('; ')}`,
            success: false,
            error: `delegation_denied: ${decision.reasons.join('; ')}`,
          };
        }
        // The subagent runs under the attenuated, signed child mandate.
        runtimeOptions.mandate = decision.childMandate;
      }

      try {
        // Race against timeout
        const resultPromise = executor(entry.definition, prompt, runtimeOptions);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Subagent "${agent}" timed out after ${timeout}ms`)), timeout),
        );

        const result = await Promise.race([resultPromise, timeoutPromise]);

        if (!result.success) {
          return {
            llmOutput: `Subagent "${agent}" failed: ${result.error ?? result.output}`,
            success: false,
            error: result.error ?? 'Subagent failed',
          };
        }

        return {
          llmOutput: result.output,
          success: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          llmOutput: `Delegation to "${agent}" failed: ${msg}`,
          success: false,
          error: msg,
        };
      }
    },
  }) as ToolContract;
}
