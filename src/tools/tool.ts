/**
 * @packageDocumentation
 * @module tool
 * @description
 * Convenience helper for creating typed tool contracts.
 */

import type { z } from 'zod';
import type { ToolContract, ToolSafetyClass, ToolResult, ToolExecuteParams, CostEstimate } from '../types/tools';

/** Options for the `tool()` helper function. */
export interface ToolOptions<TInput, TOutput> {
  name: string;
  description: string;
  input: z.ZodType<TInput>;
  output?: z.ZodType<TOutput>;
  safetyClass: ToolSafetyClass;
  execute: (params: ToolExecuteParams<TInput>) => Promise<ToolResult>;
  timeoutMs?: number;
  retries?: number;
  idempotent?: boolean;
  permissions?: string[];
  costEstimate?: (input: TInput) => CostEstimate;
  metadata?: Record<string, unknown>;
}

/**
 * Create a typed tool contract.
 *
 * @example
 * ```ts
 * const fetchBalance = tool({
 *   name: 'fetch_balance',
 *   description: 'Get wallet balance',
 *   input: z.object({ address: z.string() }),
 *   safetyClass: 'read',
 *   async execute({ input }) {
 *     return { llmOutput: `Balance: 100`, success: true };
 *   },
 * });
 * ```
 */
export function tool<TInput = unknown, TOutput = unknown>(
  options: ToolOptions<TInput, TOutput>,
): ToolContract<TInput, TOutput> {
  return {
    name: options.name,
    description: options.description,
    input: options.input,
    output: options.output,
    safetyClass: options.safetyClass,
    execute: options.execute,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    idempotent: options.idempotent,
    permissions: options.permissions,
    costEstimate: options.costEstimate,
    metadata: options.metadata,
  };
}
