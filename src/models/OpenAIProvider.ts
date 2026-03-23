/**
 * @packageDocumentation
 * @module OpenAIProvider
 * @description
 * OpenAI model provider for the Veridex Agent Fabric.
 * Uses the official `openai` SDK for production-grade API interaction.
 * Supports GPT-4, GPT-4o, GPT-5, o-series, and any OpenAI-compatible API.
 *
 * Requires `openai` as a peer dependency:
 * ```bash
 * npm install openai
 * ```
 */

import type {
  ModelProvider,
  ModelMessage,
  ModelResponse,
  ModelCompletionOptions,
  ModelToolDefinition,
  ModelUsage,
} from '../types/models';

export interface OpenAIProviderConfig {
  /** API key. Falls back to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Base URL for OpenAI-compatible APIs. */
  baseUrl?: string;
  /** Default model to use. */
  model?: string;
  /** Default temperature for sampling. */
  defaultTemperature?: number;
  /** Default max output tokens. */
  defaultMaxOutputTokens?: number;
  /** Max retries for transient failures (default: 2). */
  maxRetries?: number;
  /** Request timeout in milliseconds (default: SDK default). */
  timeoutMs?: number;
  /** Organization ID for OpenAI. */
  organization?: string;
  /** Project ID for OpenAI. */
  project?: string;
}

/**
 * Lazily imports the OpenAI SDK.
 * This allows @veridex/agents to be installed without `openai` if not using this provider.
 */
async function loadOpenAI(): Promise<typeof import('openai')> {
  try {
    return await import('openai');
  } catch {
    throw new Error(
      'The `openai` package is required to use OpenAIProvider. Install it: npm install openai',
    );
  }
}

export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai';
  private config: OpenAIProviderConfig;
  private clientPromise: Promise<InstanceType<typeof import('openai').default>> | null = null;

  constructor(config?: OpenAIProviderConfig) {
    this.config = {
      apiKey: config?.apiKey,
      baseUrl: config?.baseUrl,
      model: config?.model ?? 'gpt-4o',
      defaultTemperature: config?.defaultTemperature ?? 0.7,
      defaultMaxOutputTokens: config?.defaultMaxOutputTokens,
      maxRetries: config?.maxRetries ?? 2,
      timeoutMs: config?.timeoutMs,
      organization: config?.organization,
      project: config?.project,
    };
  }

  private async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = loadOpenAI().then((mod) => {
        const OpenAI = mod.default;
        return new OpenAI({
          apiKey: this.config.apiKey, // SDK falls back to OPENAI_API_KEY env
          baseURL: this.config.baseUrl,
          maxRetries: this.config.maxRetries,
          timeout: this.config.timeoutMs,
          organization: this.config.organization,
          project: this.config.project,
        });
      });
    }
    return this.clientPromise;
  }

  async complete(
    messages: ModelMessage[],
    options?: ModelCompletionOptions,
  ): Promise<ModelResponse> {
    const client = await this.getClient();

    const params: Parameters<typeof client.chat.completions.create>[0] = {
      model: this.config.model!,
      messages: messages.map((m) => this.formatMessage(m)),
      temperature: options?.temperature ?? this.config.defaultTemperature,
    };

    const maxTokens = options?.maxOutputTokens ?? this.config.defaultMaxOutputTokens;
    if (maxTokens) {
      params.max_tokens = maxTokens;
    }

    if (options?.topP !== undefined) {
      params.top_p = options.topP;
    }

    if (options?.tools?.length) {
      params.tools = options.tools.map((t) => this.formatTool(t));
      params.tool_choice = 'auto';
    }

    const requestOptions: Parameters<typeof client.chat.completions.create>[1] = {};
    if (options?.signal) {
      requestOptions.signal = options.signal;
    }

    // Streaming path — when onToken callback is provided
    if (options?.onToken) {
      params.stream = true;
      const stream = await client.chat.completions.create(params, requestOptions);

      let content = '';
      let model = this.config.model!;
      const toolCallsAcc: Map<number, { id: string; name: string; args: string }> = new Map();
      let finishReason: string | null = null;
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const chunk of stream as AsyncIterable<import('openai').ChatCompletionChunk>) {
        const delta = chunk.choices[0]?.delta;
        if (chunk.model) model = chunk.model;

        if (delta?.content) {
          content += delta.content;
          options.onToken(delta.content);
        }

        // Accumulate streamed tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallsAcc.get(tc.index);
            if (!existing) {
              toolCallsAcc.set(tc.index, {
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

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
        }
      }

      const toolCalls = toolCallsAcc.size > 0
        ? [...toolCallsAcc.values()].map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.args,
          }))
        : undefined;

      const mappedFinishReason: ModelResponse['finishReason'] =
        toolCalls ? 'tool_calls'
          : finishReason === 'length' ? 'length'
            : finishReason === 'content_filter' ? 'content_filter'
              : 'stop';

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
        finishReason: mappedFinishReason,
      };
    }

    // Non-streaming path
    const completion = await client.chat.completions.create(params, requestOptions);

    return this.parseResponse(completion as import('openai').ChatCompletion);
  }

  private formatMessage(
    msg: ModelMessage,
  ): import('openai').ChatCompletionMessageParam {
    if (msg.role === 'system') {
      return { role: 'system', content: msg.content };
    }

    if (msg.role === 'user') {
      return { role: 'user', content: msg.content };
    }

    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: msg.content,
        tool_call_id: msg.toolCallId!,
      };
    }

    // assistant
    const assistantMsg: import('openai').ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: msg.content || null,
    };

    if (msg.toolCalls?.length) {
      assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }

    return assistantMsg;
  }

  private formatTool(
    tool: ModelToolDefinition,
  ): import('openai').ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
      },
    };
  }

  private parseResponse(
    completion: import('openai').ChatCompletion,
  ): ModelResponse {
    const choice = completion.choices[0];
    const message = choice?.message;

    const toolCalls = message?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    const finishReason = choice?.finish_reason;
    const mappedFinishReason: ModelResponse['finishReason'] =
      finishReason === 'tool_calls' ? 'tool_calls'
        : finishReason === 'length' ? 'length'
          : finishReason === 'content_filter' ? 'content_filter'
            : 'stop';

    const usage: ModelUsage = {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens ?? 0,
    };

    return {
      content: message?.content ?? '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      model: completion.model,
      provider: this.name,
      usage,
      finishReason: toolCalls?.length ? 'tool_calls' : mappedFinishReason,
    };
  }
}
