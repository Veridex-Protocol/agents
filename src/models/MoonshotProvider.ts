/**
 * @packageDocumentation
 * @module MoonshotProvider
 * @description
 * Moonshot AI (Kimi) model provider. Uses the OpenAI-compatible Moonshot API.
 * Supports moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k, and future models.
 *
 * ```ts
 * runtime.models.register(new MoonshotProvider({ apiKey: 'sk-...' }));
 * ```
 */

import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';

export interface MoonshotProviderConfig {
  /** API key. Falls back to MOONSHOT_API_KEY env var. */
  apiKey?: string;
  /** Model name (default: 'moonshot-v1-128k'). */
  model?: string;
  /** Temperature (default: 0.7). */
  defaultTemperature?: number;
  /** Max output tokens. */
  defaultMaxOutputTokens?: number;
  /** Timeout ms. */
  timeoutMs?: number;
}

export class MoonshotProvider extends OpenAICompatibleProvider {
  constructor(config?: MoonshotProviderConfig) {
    const apiKey = config?.apiKey ?? (typeof process !== 'undefined' ? process.env.MOONSHOT_API_KEY : undefined);
    super({
      name: 'moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey,
      model: config?.model ?? 'moonshot-v1-128k',
      defaultTemperature: config?.defaultTemperature,
      defaultMaxOutputTokens: config?.defaultMaxOutputTokens,
      timeoutMs: config?.timeoutMs,
    });
  }
}
