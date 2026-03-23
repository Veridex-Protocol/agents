/**
 * @packageDocumentation
 * @module ModelTypes
 * @description
 * Model provider abstraction types for the Veridex Agent Fabric.
 */

// ── Model Config ──

/** Model configuration for an agent definition. */
export interface ModelConfig {
  /** Model provider name (e.g., 'openai', 'anthropic') */
  provider: string;
  /** Model name (e.g., 'gpt-4o', 'claude-sonnet-4') */
  model: string;
  /** Fallback models to try if primary fails */
  fallback?: string[];
  /** Temperature (0-2, default: 0.7) */
  temperature?: number;
  /** Maximum output tokens */
  maxOutputTokens?: number;
  /** Top-p sampling */
  topP?: number;
  /** API key (if not set via environment) */
  apiKey?: string;
  /** Base URL override */
  baseUrl?: string;
}

// ── Model Messages ──

/** Role of a message in the conversation. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** A message in the model conversation. */
export interface ModelMessage {
  /** Message role */
  role: MessageRole;
  /** Text content */
  content: string;
  /** Tool calls (for assistant messages) */
  toolCalls?: ModelToolCall[];
  /** Tool call ID (for tool result messages) */
  toolCallId?: string;
}

/** A tool call from the model's response. */
export interface ModelToolCall {
  /** Tool call ID */
  id: string;
  /** Tool name */
  name: string;
  /** Tool arguments as JSON string */
  arguments: string;
}

// ── Model Response ──

/** Response from a model provider. */
export interface ModelResponse {
  /** Text content of the response */
  content: string;
  /** Tool calls requested by the model */
  toolCalls?: ModelToolCall[];
  /** Model that generated this response */
  model: string;
  /** Provider name */
  provider: string;
  /** Token usage */
  usage: ModelUsage;
  /** Finish reason */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
}

/** Token usage statistics from a model call. */
export interface ModelUsage {
  /** Input/prompt tokens */
  inputTokens: number;
  /** Output/completion tokens */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
}

// ── Model Provider Interface ──

/** Options for a model completion request. */
export interface ModelCompletionOptions {
  /** Temperature override */
  temperature?: number;
  /** Max output tokens override */
  maxOutputTokens?: number;
  /** Top-p override */
  topP?: number;
  /** Tool definitions available to the model */
  tools?: ModelToolDefinition[];
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Streaming text callback — called with each text chunk as it arrives. */
  onToken?: (token: string) => void;
}

/** Tool definition for the model (JSON Schema format). */
export interface ModelToolDefinition {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** Parameters schema (JSON Schema) */
  parameters: Record<string, unknown>;
}

/** Interface that model providers must implement. */
export interface ModelProvider {
  /** Provider name */
  readonly name: string;
  /** Complete a conversation. */
  complete(
    messages: ModelMessage[],
    options?: ModelCompletionOptions,
  ): Promise<ModelResponse>;
}
