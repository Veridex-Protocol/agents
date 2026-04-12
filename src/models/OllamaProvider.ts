/**
 * @packageDocumentation
 * @module OllamaProvider
 * @description
 * Local model provider for Ollama, vLLM, LM Studio, LocalAI, and any
 * OpenAI-compatible local inference server.
 *
 * Supports streaming, tool calling (on capable models), and automatic
 * discovery of available models.
 *
 * ```ts
 * // Ollama (default)
 * runtime.models.register(new OllamaProvider({ model: 'llama3.3' }));
 *
 * // vLLM
 * runtime.models.register(new OllamaProvider({
 *   name: 'vllm',
 *   baseUrl: 'http://localhost:8000/v1',
 *   model: 'meta-llama/Llama-3.3-70B-Instruct',
 * }));
 *
 * // LM Studio
 * runtime.models.register(new OllamaProvider({
 *   name: 'lmstudio',
 *   baseUrl: 'http://localhost:1234/v1',
 *   model: 'local-model',
 * }));
 * ```
 */

import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';

export interface OllamaProviderConfig {
  /** Provider name override (default: 'ollama'). Use 'vllm', 'lmstudio', etc. */
  name?: string;
  /** Base URL (default: http://localhost:11434/v1 for Ollama). */
  baseUrl?: string;
  /** API key (usually not needed for local). */
  apiKey?: string;
  /** Model name (default: 'llama3.3'). */
  model?: string;
  /** Temperature (default: 0.7). */
  defaultTemperature?: number;
  /** Max output tokens. */
  defaultMaxOutputTokens?: number;
  /** Timeout ms (default: 300000 — local can be slow). */
  timeoutMs?: number;
  /** Whether the model supports tool/function calling (default: true). */
  supportsTools?: boolean;
}

export class OllamaProvider extends OpenAICompatibleProvider {
  constructor(config?: OllamaProviderConfig) {
    super({
      name: config?.name ?? 'ollama',
      baseUrl: config?.baseUrl ?? 'http://localhost:11434/v1',
      apiKey: config?.apiKey ?? 'ollama', // Ollama ignores this but requires it for the endpoint
      model: config?.model ?? 'llama3.3',
      defaultTemperature: config?.defaultTemperature,
      defaultMaxOutputTokens: config?.defaultMaxOutputTokens,
      timeoutMs: config?.timeoutMs ?? 300_000,
      supportsTools: config?.supportsTools,
      // Ollama doesn't support stream_options for usage in streaming
      supportsStreamOptions: false,
    });
  }

  /**
   * List available models on the server.
   * Works with Ollama's /api/tags endpoint.
   */
  async listModels(): Promise<string[]> {
    // Ollama has a dedicated /api/tags; for vLLM/LMStudio use /v1/models
    const ollamaBase = this.config.baseUrl.replace(/\/v1\/?$/, '');

    try {
      // Try Ollama format first
      const res = await fetch(`${ollamaBase}/api/tags`);
      if (res.ok) {
        const data = await res.json() as { models?: Array<{ name: string }> };
        return data.models?.map((m) => m.name) ?? [];
      }
    } catch {
      // Not Ollama — try OpenAI-compatible /v1/models
    }

    try {
      const headers: Record<string, string> = {};
      if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
      const res = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/models`, { headers });
      if (res.ok) {
        const data = await res.json() as { data?: Array<{ id: string }> };
        return data.data?.map((m) => m.id) ?? [];
      }
    } catch {
      // Server unreachable
    }

    return [];
  }

  /**
   * Check if the local server is running.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const ollamaBase = this.config.baseUrl.replace(/\/v1\/?$/, '');
      const res = await fetch(ollamaBase, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
