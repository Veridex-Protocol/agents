/**
 * @packageDocumentation
 * @module QwenProvider
 * @description
 * Alibaba Cloud (Qwen/Tongyi) model provider. Uses the OpenAI-compatible DashScope API.
 * Supports Qwen-Max, Qwen-Plus, Qwen-Turbo, Qwen-2.5, and future models.
 *
 * ```ts
 * runtime.models.register(new QwenProvider({ apiKey: 'sk-...' }));
 * ```
 */

import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';

export interface QwenProviderConfig {
  /** API key. Falls back to DASHSCOPE_API_KEY env var. */
  apiKey?: string;
  /** Base URL override (default: DashScope OpenAI-compatible endpoint). */
  baseUrl?: string;
  /** Model name (default: 'qwen-max'). */
  model?: string;
  /** Temperature (default: 0.7). */
  defaultTemperature?: number;
  /** Max output tokens. */
  defaultMaxOutputTokens?: number;
  /** Timeout ms. */
  timeoutMs?: number;
}

export class QwenProvider extends OpenAICompatibleProvider {
  constructor(config?: QwenProviderConfig) {
    const apiKey = config?.apiKey ?? (typeof process !== 'undefined' ? process.env.DASHSCOPE_API_KEY : undefined);
    super({
      name: 'qwen',
      baseUrl: config?.baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey,
      model: config?.model ?? 'qwen-max',
      defaultTemperature: config?.defaultTemperature,
      defaultMaxOutputTokens: config?.defaultMaxOutputTokens,
      timeoutMs: config?.timeoutMs,
    });
  }
}
