/**
 * @packageDocumentation
 * @module OpenAICompatibleProvider
 * @description
 * Base provider for any OpenAI-compatible API.
 * xAI (Grok), DeepSeek, Zhipu AI (GLM), Alibaba (Qwen), Moonshot AI (Kimi),
 * Ollama, vLLM, LM Studio, and any other API that conforms to the
 * OpenAI chat completions interface.
 *
 * This class handles streaming, tool calls, and message formatting uniformly.
 * Concrete providers extend this with correct defaults.
 *
 * Usage (direct):
 * ```ts
 * const provider = new OpenAICompatibleProvider({
 *   name: 'my-provider',
 *   baseUrl: 'https://my-api.com/v1',
 *   apiKey: 'key',
 *   model: 'my-model',
 * });
 * ```
 */

import type {
  ModelProvider,
  ModelMessage,
  ModelResponse,
  ModelCompletionOptions,
  ModelToolDefinition,
} from '../types/models';

export interface OpenAICompatibleConfig {
  /** Provider name (used in ModelRegistry). */
  name: string;
  /** Base URL of the OpenAI-compatible API (e.g., https://api.deepseek.com/v1). */
  baseUrl: string;
  /** API key. Optional for local models. */
  apiKey?: string;
  /** Default model to use. */
  model: string;
  /** Default temperature (default: 0.7). */
  defaultTemperature?: number;
  /** Default max output tokens. */
  defaultMaxOutputTokens?: number;
  /** Request timeout in ms (default: 120000). */
  timeoutMs?: number;
  /** Extra headers to send with every request. */
  extraHeaders?: Record<string, string>;
  /** Whether the provider supports tool/function calling (default: true). */
  supportsTools?: boolean;
  /** Whether to include stream_options for usage in streaming (default: true). */
  supportsStreamOptions?: boolean;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  protected config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.name;
    this.config = {
      ...config,
      defaultTemperature: config.defaultTemperature ?? 0.7,
      timeoutMs: config.timeoutMs ?? 120_000,
      supportsTools: config.supportsTools ?? true,
      supportsStreamOptions: config.supportsStreamOptions ?? true,
    };
  }

  async complete(
    messages: ModelMessage[],
    options?: ModelCompletionOptions,
  ): Promise<ModelResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const isStreaming = !!options?.onToken;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map((m) => this.formatMessage(m)),
      temperature: options?.temperature ?? this.config.defaultTemperature,
      stream: isStreaming,
    };

    if (options?.maxOutputTokens ?? this.config.defaultMaxOutputTokens) {
      body.max_tokens = options?.maxOutputTokens ?? this.config.defaultMaxOutputTokens;
    }
    if (options?.topP !== undefined) {
      body.top_p = options.topP;
    }
    if (options?.tools?.length && this.config.supportsTools) {
      body.tools = options.tools.map((t) => this.formatTool(t));
      body.tool_choice = 'auto';
    }
    if (isStreaming && this.config.supportsStreamOptions) {
      body.stream_options = { include_usage: true };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...(this.config.extraHeaders ?? {}),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs!,
    );

    // Merge with user's abort signal
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${this.name} API error (${res.status}): ${text}`);
      }

      if (isStreaming) {
        return this.handleStream(res, options!.onToken!);
      }

      return this.handleResponse(await res.json() as Record<string, unknown>);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Streaming ──

  private async handleStream(
    res: Response,
    onToken: (token: string) => void,
  ): Promise<ModelResponse> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let content = '';
    let model = this.config.model;
    const toolCallsAcc = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep partial last line in buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (chunk.model) model = chunk.model;

          if (delta?.content) {
            content += delta.content;
            onToken(delta.content);
          }

          // Tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCallsAcc.get(idx);
              if (!existing) {
                toolCallsAcc.set(idx, {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  args: tc.function?.arguments ?? '',
                });
              } else {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
              }
            }
          }

          if (chunk.choices?.[0]?.finish_reason) {
            finishReason = chunk.choices[0].finish_reason;
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? 0;
            completionTokens = chunk.usage.completion_tokens ?? 0;
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    const toolCalls = toolCallsAcc.size > 0
      ? [...toolCallsAcc.values()].map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.args,
        }))
      : undefined;

    return {
      content,
      toolCalls,
      model,
      provider: this.name,
      usage: {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: this.mapFinishReason(finishReason, !!toolCalls),
    };
  }

  // ── Non-streaming ──

  private handleResponse(json: Record<string, unknown>): ModelResponse {
    const choice = (json.choices as any[])?.[0];
    const message = choice?.message ?? {};

    const toolCalls = message.tool_calls?.map((tc: any) => ({
      id: tc.id ?? '',
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? '',
    }));

    const usage = json.usage as any;

    return {
      content: message.content ?? '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      model: (json.model as string) ?? this.config.model,
      provider: this.name,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        totalTokens: (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
      },
      finishReason: this.mapFinishReason(choice?.finish_reason, !!toolCalls?.length),
    };
  }

  // ── Helpers ──

  protected formatMessage(msg: ModelMessage): Record<string, unknown> {
    if (msg.role === 'tool') {
      return { role: 'tool', content: msg.content, tool_call_id: msg.toolCallId };
    }
    const m: Record<string, unknown> = { role: msg.role, content: msg.content || null };
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      m.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    return m;
  }

  protected formatTool(tool: ModelToolDefinition): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }

  private mapFinishReason(
    reason: string | null,
    hasToolCalls: boolean,
  ): ModelResponse['finishReason'] {
    if (hasToolCalls) return 'tool_calls';
    switch (reason) {
      case 'length': return 'length';
      case 'content_filter': return 'content_filter';
      default: return 'stop';
    }
  }
}
