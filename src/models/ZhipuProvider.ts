/**
 * @packageDocumentation
 * @module ZhipuProvider
 * @description
 * Zhipu AI (GLM) model provider. Uses the OpenAI-compatible Zhipu API.
 * Supports GLM-4, GLM-4-Air, GLM-4-Flash, and future models.
 *
 * ```ts
 * runtime.models.register(new ZhipuProvider({ apiKey: '...' }));
 * ```
 */

import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';

export interface ZhipuProviderConfig {
  /** API key. Falls back to ZHIPU_API_KEY env var. */
  apiKey?: string;
  /** Model name (default: 'glm-4'). */
  model?: string;
  /** Temperature (default: 0.7). */
  defaultTemperature?: number;
  /** Max output tokens. */
  defaultMaxOutputTokens?: number;
  /** Timeout ms. */
  timeoutMs?: number;
}

export class ZhipuProvider extends OpenAICompatibleProvider {
  constructor(config?: ZhipuProviderConfig) {
    const apiKey = config?.apiKey ?? (typeof process !== 'undefined' ? process.env.ZHIPU_API_KEY : undefined);
    super({
      name: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey,
      model: config?.model ?? 'glm-4',
      defaultTemperature: config?.defaultTemperature,
      defaultMaxOutputTokens: config?.defaultMaxOutputTokens,
      timeoutMs: config?.timeoutMs,
    });
  }
}
