/**
 * @packageDocumentation
 * @module ModelRegistry
 * @description
 * Registry for model providers with fallback chain support.
 */

import type { ModelProvider, ModelMessage, ModelResponse, ModelCompletionOptions } from '../types/models';

export class ModelRegistry {
  private providers = new Map<string, ModelProvider>();

  /** Register a model provider. */
  register(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** Get a provider by name. */
  get(name: string): ModelProvider | undefined {
    return this.providers.get(name);
  }

  /** Check if a provider is registered. */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /** List all registered provider names. */
  list(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Remove a provider. */
  remove(name: string): boolean {
    return this.providers.delete(name);
  }

  /**
   * Complete with fallback chain support.
   * Tries the primary provider first, then falls back to alternatives.
   */
  async completeWithFallback(
    providerName: string,
    messages: ModelMessage[],
    options?: ModelCompletionOptions & { fallbackProviders?: string[] },
  ): Promise<ModelResponse> {
    const chain = [providerName, ...(options?.fallbackProviders ?? [])];
    let lastError: Error | undefined;

    for (const name of chain) {
      const provider = this.providers.get(name);
      if (!provider) {
        lastError = new Error(`Model provider '${name}' not registered`);
        continue;
      }

      try {
        return await provider.complete(messages, options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error('No model providers available');
  }
}
