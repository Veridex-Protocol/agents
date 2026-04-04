/**
 * @packageDocumentation
 * @module ToolExecutor
 * @description
 * Executes tool calls with timeout, retry, validation, and metrics.
 */

import type {
  ToolContract,
  ToolResult,
  ToolContext,
  ToolCall,
  ToolMetrics,
} from '../types/tools';
import type { SideEffectReceipt, ToolExecutionOutcome } from '../types/accountability';
import type { ToolRegistry } from './ToolRegistry';
import { ToolValidator } from './ToolValidator';

export interface ToolExecutionResult {
  toolCall: ToolCall;
  result: ToolResult;
  durationMs: number;
  retryCount: number;
  outcome?: ToolExecutionOutcome;
  receipt?: SideEffectReceipt;
}

export class ToolExecutor {
  private validator: ToolValidator;

  constructor(
    private registry: ToolRegistry,
    validator?: ToolValidator,
  ) {
    this.validator = validator ?? new ToolValidator();
  }

  /** Execute a single tool call. */
  async execute(
    toolCall: ToolCall,
    context: ToolContext,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const tool = this.registry.get(toolCall.name);
    if (!tool) {
      return {
        toolCall,
        result: {
          llmOutput: `Error: Tool '${toolCall.name}' not found`,
          success: false,
          error: `Tool '${toolCall.name}' not found`,
        },
        durationMs: 0,
        retryCount: 0,
      };
    }

    // Validate input
    const validationError = this.validator.validateInput(tool, toolCall.arguments);
    if (validationError) {
      return {
        toolCall,
        result: {
          llmOutput: `Validation error: ${validationError}`,
          success: false,
          error: validationError,
        },
        durationMs: 0,
        retryCount: 0,
      };
    }

    const maxRetries = tool.retries ?? 0;
    let lastError: Error | undefined;
    let retryCount = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) retryCount++;

      const start = Date.now();
      try {
        const result = await this.executeWithTimeout(tool, toolCall, context, signal);
        const durationMs = Date.now() - start;

        // Attach metrics
        result.metrics = {
          ...result.metrics,
          durationMs,
        } as ToolMetrics;

        return { toolCall, result, durationMs, retryCount };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry if abort signal fired or tool is not idempotent
        if (signal?.aborted || !tool.idempotent) break;
      }
    }

    return {
      toolCall,
      result: {
        llmOutput: `Tool execution failed: ${lastError?.message ?? 'Unknown error'}`,
        success: false,
        error: lastError?.message ?? 'Unknown error',
      },
      durationMs: 0,
      retryCount,
    };
  }

  /** Execute multiple tool calls (sequentially for safety). */
  async executeAll(
    toolCalls: ToolCall[],
    context: ToolContext,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];

    for (const call of toolCalls) {
      if (signal?.aborted) {
        results.push({
          toolCall: call,
          result: {
            llmOutput: 'Execution aborted',
            success: false,
            error: 'Execution aborted',
          },
          durationMs: 0,
          retryCount: 0,
        });
        continue;
      }

      const result = await this.execute(call, context, signal);
      results.push(result);
    }

    return results;
  }

  private async executeWithTimeout(
    tool: ToolContract,
    toolCall: ToolCall,
    context: ToolContext,
    parentSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const timeoutMs = tool.timeoutMs ?? 30000;
    const controller = new AbortController();

    // Link parent signal
    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await tool.execute({
        input: toolCall.arguments,
        context,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }
}
