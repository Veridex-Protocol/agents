/**
 * @packageDocumentation
 * @module AnthropicProvider
 * @description
 * Anthropic model provider for the Veridex Agent Fabric.
 * Uses the official `@anthropic-ai/sdk` for production-grade API interaction.
 * Supports all Claude models including Claude Opus 4, Sonnet 4, and Haiku.
 *
 * Requires `@anthropic-ai/sdk` as a peer dependency:
 * ```bash
 * npm install @anthropic-ai/sdk
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

export interface AnthropicProviderConfig {
  /** API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Base URL override. */
  baseUrl?: string;
  /** Default model to use. */
  model?: string;
  /** Default temperature for sampling. */
  defaultTemperature?: number;
  /** Default max output tokens. */
  defaultMaxOutputTokens?: number;
  /** Max retries for transient failures (default: 2). */
  maxRetries?: number;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Lazily imports the Anthropic SDK.
 * This allows @veridex/agents to be installed without `@anthropic-ai/sdk` if not using this provider.
 */
async function loadAnthropic(): Promise<typeof import('@anthropic-ai/sdk')> {
  try {
    return await import('@anthropic-ai/sdk');
  } catch {
    throw new Error(
      'The `@anthropic-ai/sdk` package is required to use AnthropicProvider. Install it: npm install @anthropic-ai/sdk',
    );
  }
}

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  private config: AnthropicProviderConfig;
  private clientPromise: Promise<InstanceType<typeof import('@anthropic-ai/sdk').default>> | null = null;

  constructor(config?: AnthropicProviderConfig) {
    this.config = {
      apiKey: config?.apiKey,
      baseUrl: config?.baseUrl,
      model: config?.model ?? 'claude-sonnet-4-20250514',
      defaultTemperature: config?.defaultTemperature ?? 0.7,
      defaultMaxOutputTokens: config?.defaultMaxOutputTokens ?? 4096,
      maxRetries: config?.maxRetries ?? 2,
      timeoutMs: config?.timeoutMs,
    };
  }

  private async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = loadAnthropic().then((mod) => {
        const Anthropic = mod.default;
        return new Anthropic({
          apiKey: this.config.apiKey, // SDK falls back to ANTHROPIC_API_KEY env
          baseURL: this.config.baseUrl,
          maxRetries: this.config.maxRetries,
          timeout: this.config.timeoutMs,
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

    // Extract system messages — Anthropic handles system as a top-level param
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const systemPrompt = systemMessages.map((m) => m.content).join('\n\n');

    const params: import('@anthropic-ai/sdk').MessageCreateParams = {
      model: this.config.model!,
      messages: nonSystemMessages.map((m) => this.formatMessage(m)),
      max_tokens: options?.maxOutputTokens ?? this.config.defaultMaxOutputTokens ?? 4096,
      temperature: options?.temperature ?? this.config.defaultTemperature,
    };

    if (systemPrompt) {
      params.system = systemPrompt;
    }

    if (options?.topP !== undefined) {
      params.top_p = options.topP;
    }

    if (options?.tools?.length) {
      params.tools = options.tools.map((t) => this.formatTool(t));
    }

    const requestOptions: import('@anthropic-ai/sdk').RequestOptions = {};
    if (options?.signal) {
      requestOptions.signal = options.signal;
    }

    // Streaming path — when onToken callback is provided
    if (options?.onToken) {
      params.stream = true;
      const stream = await client.messages.create(params, requestOptions);

      let textContent = '';
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let currentToolId = '';
      let currentToolName = '';
      let currentToolInput = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: string | null = null;
      let model = this.config.model!;

      for await (const event of stream as AsyncIterable<import('@anthropic-ai/sdk').MessageStreamEvent>) {
        switch (event.type) {
          case 'message_start':
            if (event.message?.usage) {
              inputTokens = event.message.usage.input_tokens;
            }
            if (event.message?.model) {
              model = event.message.model;
            }
            break;
          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              currentToolId = event.content_block.id;
              currentToolName = event.content_block.name;
              currentToolInput = '';
            }
            break;
          case 'content_block_delta':
            if (event.delta?.type === 'text_delta') {
              textContent += event.delta.text;
              options.onToken(event.delta.text);
            } else if (event.delta?.type === 'input_json_delta') {
              currentToolInput += event.delta.partial_json;
            }
            break;
          case 'content_block_stop':
            if (currentToolId) {
              toolCalls.push({
                id: currentToolId,
                name: currentToolName,
                arguments: currentToolInput,
              });
              currentToolId = '';
              currentToolName = '';
              currentToolInput = '';
            }
            break;
          case 'message_delta':
            if (event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            if (event.usage) {
              outputTokens = event.usage.output_tokens;
            }
            break;
        }
      }

      const finishReason: ModelResponse['finishReason'] =
        stopReason === 'tool_use' ? 'tool_calls'
          : stopReason === 'max_tokens' ? 'length'
            : 'stop';

      return {
        content: textContent,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        model,
        provider: this.name,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        finishReason,
      };
    }

    // Non-streaming path
    const message = await client.messages.create(params, requestOptions);

    return this.parseResponse(message);
  }

  private formatMessage(
    msg: ModelMessage,
  ): import('@anthropic-ai/sdk').MessageParam {
    // Tool result messages → Anthropic expects them as user messages with tool_result content
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.toolCallId!,
          content: msg.content,
        }],
      };
    }

    // Assistant messages with tool calls → content blocks
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const content: import('@anthropic-ai/sdk').ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.arguments) as Record<string, unknown>,
        });
      }
      return { role: 'assistant', content };
    }

    // Regular user or assistant message
    return {
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
    };
  }

  private formatTool(
    tool: ModelToolDefinition,
  ): import('@anthropic-ai/sdk').Tool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        ...tool.parameters,
      },
    };
  }

  private parseResponse(
    message: import('@anthropic-ai/sdk').Message,
  ): ModelResponse {
    let textContent = '';
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    for (const block of message.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    const finishReason: ModelResponse['finishReason'] =
      message.stop_reason === 'tool_use' ? 'tool_calls'
        : message.stop_reason === 'max_tokens' ? 'length'
          : 'stop';

    const usage: ModelUsage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      totalTokens: message.usage.input_tokens + message.usage.output_tokens,
    };

    return {
      content: textContent,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      model: message.model,
      provider: this.name,
      usage,
      finishReason,
    };
  }
}
