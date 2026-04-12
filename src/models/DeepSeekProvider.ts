/**
 * @packageDocumentation
 * @module DeepSeekProvider
 * @description
 * DeepSeek model provider. Uses the OpenAI-compatible DeepSeek API.
 * Supports DeepSeek-V3, DeepSeek-R1, DeepSeek-Coder, and future models.
 *
 * ```ts
 * runtime.models.register(new DeepSeekProvider({ apiKey: 'sk-...' }));
 * ```
 */

import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';

export interface DeepSeekProviderConfig {
  /** API key. Falls back to DEEPSEEK_API_KEY env var. */
  apiKey?: string;
  /** Model name (default: 'deepseek-chat'). */
  model?: string;
  /** Temperature (default: 0.7). */
  defaultTemperature?: number;
  /** Max output tokens. */
  defaultMaxOutputTokens?: number;
  /** Timeout ms. */
  timeoutMs?: number;
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(config?: DeepSeekProviderConfig) {
    const apiKey = config?.apiKey ?? (typeof process !== 'undefined' ? process.env.DEEPSEEK_API_KEY : undefined);
    super({
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey,
      model: config?.model ?? 'deepseek-chat',
      defaultTemperature: config?.defaultTemperature,
      defaultMaxOutputTokens: config?.defaultMaxOutputTokens,
      timeoutMs: config?.timeoutMs,
    });
  }
}
