/**
 * @packageDocumentation
 * @module XAIProvider
 * @description
 * xAI (Grok) model provider. Uses the OpenAI-compatible xAI API.
 * Supports Grok-2, Grok-3, and future models with full streaming + tool calling.
 *
 * ```ts
 * const runtime = new AgentRuntime(definition);
 * runtime.models.register(new XAIProvider({ apiKey: 'xai-...' }));
 * ```
 */

import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './OpenAICompatibleProvider';

export interface XAIProviderConfig {
  /** API key. Falls back to XAI_API_KEY env var. */
  apiKey?: string;
  /** Model name (default: 'grok-3'). */
  model?: string;
  /** Temperature (default: 0.7). */
  defaultTemperature?: number;
  /** Max output tokens. */
  defaultMaxOutputTokens?: number;
  /** Timeout ms (default: 120000). */
  timeoutMs?: number;
}

export class XAIProvider extends OpenAICompatibleProvider {
  constructor(config?: XAIProviderConfig) {
    const apiKey = config?.apiKey ?? (typeof process !== 'undefined' ? process.env.XAI_API_KEY : undefined);
    super({
      name: 'xai',
      baseUrl: 'https://api.x.ai/v1',
      apiKey,
      model: config?.model ?? 'grok-3',
      defaultTemperature: config?.defaultTemperature,
      defaultMaxOutputTokens: config?.defaultMaxOutputTokens,
      timeoutMs: config?.timeoutMs,
    });
  }
}
