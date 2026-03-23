/**
 * @packageDocumentation
 * @module createAgent
 * @description
 * Convenience factory for creating agent definitions and runtimes.
 */

import type { AgentDefinition, RuntimeOptions } from '../types/agent';
import { AgentRuntime } from './AgentRuntime';

/**
 * Create an agent runtime from a definition and options.
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   id: 'my-agent',
 *   name: 'My Agent',
 *   model: { provider: 'openai', model: 'gpt-4o' },
 *   instructions: 'You are a helpful assistant.',
 *   tools: [fetchBalance],
 * });
 *
 * const result = await agent.run('Check my balance');
 * ```
 */
export function createAgent(
  definition: AgentDefinition,
  options?: RuntimeOptions,
): AgentRuntime {
  return new AgentRuntime(definition, options);
}
