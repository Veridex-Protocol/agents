/**
 * @packageDocumentation
 * @module GeminiProvider
 * @description
 * Google Gemini model provider for the Veridex Agent Fabric.
 * Uses native `fetch` against the Gemini REST API — no SDK dependency.
 * Supports streaming via SSE, tool calls (function calling), and all
 * Gemini models (2.5 Flash, 2.5 Pro, etc.).
 *
 * ```ts
 * const provider = new GeminiProvider({ apiKey: 'AIza...' });
 * const res = await provider.complete([{ role: 'user', content: 'Hello' }]);
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

export interface GeminiProviderConfig {
  /** Google AI API key. Falls back to GOOGLE_API_KEY or GEMINI_API_KEY env. */
  apiKey?: string;
  /** Base URL. Default: https://generativelanguage.googleapis.com */
  baseUrl?: string;
  /** Model name. Default: gemini-2.5-flash */
  model?: string;
  /** Default temperature. */
  defaultTemperature?: number;
  /** Default max output tokens. */
  defaultMaxOutputTokens?: number;
  /** Request timeout in ms (default: 120000). */
  timeoutMs?: number;
}

export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';
  private config: Required<GeminiProviderConfig>;

  constructor(config?: GeminiProviderConfig) {
    const apiKey = config?.apiKey
      ?? (typeof process !== 'undefined' ? process.env?.GOOGLE_API_KEY ?? process.env?.GEMINI_API_KEY : undefined)
      ?? '';

    this.config = {
      apiKey,
      baseUrl: (config?.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
      model: config?.model ?? 'gemini-2.5-flash',
      defaultTemperature: config?.defaultTemperature ?? 0.7,
      defaultMaxOutputTokens: config?.defaultMaxOutputTokens ?? 8192,
      timeoutMs: config?.timeoutMs ?? 120_000,
    };
  }

  async complete(
    messages: ModelMessage[],
    options?: ModelCompletionOptions,
  ): Promise<ModelResponse> {
    const { apiKey, baseUrl, model, timeoutMs } = this.config;
    if (!apiKey) throw new Error('GeminiProvider: API key is required. Set GOOGLE_API_KEY or pass apiKey.');

    const isStreaming = !!options?.onToken;
    const method = isStreaming ? 'streamGenerateContent' : 'generateContent';
    const url = `${baseUrl}/v1beta/models/${model}:${method}?key=${encodeURIComponent(apiKey)}${isStreaming ? '&alt=sse' : ''}`;

    const body = this.buildRequestBody(messages, options);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options?.signal ?? controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        throw new Error(`Gemini API error (${res.status}): ${text}`);
      }

      if (isStreaming) {
        return this.handleStream(res, options?.onToken!);
      }

      return this.handleResponse(await res.json() as Record<string, unknown>);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Request Building ──

  private buildRequestBody(
    messages: ModelMessage[],
    options?: ModelCompletionOptions,
  ): Record<string, unknown> {
    const { contents, systemInstruction } = this.formatMessages(messages);

    const body: Record<string, unknown> = { contents };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    // Generation config
    body.generationConfig = {
      temperature: options?.temperature ?? this.config.defaultTemperature,
      maxOutputTokens: options?.maxOutputTokens ?? this.config.defaultMaxOutputTokens,
      ...(options?.topP != null ? { topP: options.topP } : {}),
    };

    // Tool declarations
    if (options?.tools?.length) {
      body.tools = [{
        functionDeclarations: options.tools.map((t) => this.formatTool(t)),
      }];
    }

    return body;
  }

  private formatMessages(messages: ModelMessage[]): {
    contents: Array<Record<string, unknown>>;
    systemInstruction: Record<string, unknown> | null;
  } {
    let systemInstruction: Record<string, unknown> | null = null;
    const contents: Array<Record<string, unknown>> = [];

    // Gemini's functionResponse part requires the original function *name*,
    // not the OpenAI-style tool-call id. Build an id → name map as we walk
    // the assistant messages so we can rewrite later tool result messages.
    const toolCallIdToName = new Map<string, string>();
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) toolCallIdToName.set(tc.id, tc.name);
      }
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Gemini uses systemInstruction at top level, not in contents
        systemInstruction = {
          parts: [{ text: msg.content }],
        };
        continue;
      }

      if (msg.role === 'tool') {
        // Tool result — must be a functionResponse part. The name must be the
        // original function name; the response value must be an object.
        const fnName = (msg.toolCallId && toolCallIdToName.get(msg.toolCallId)) ?? msg.toolCallId ?? 'unknown';
        let responseValue: unknown = { result: msg.content };
        // If the tool returned JSON, surface it as a structured object.
        if (typeof msg.content === 'string') {
          const trimmed = msg.content.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { responseValue = { result: JSON.parse(trimmed) }; } catch { /* keep string */ }
          }
        }
        contents.push({
          role: 'function',
          parts: [{
            functionResponse: {
              name: fnName,
              response: responseValue,
            },
          }],
        });
        continue;
      }

      if (msg.role === 'assistant') {
        const parts: Array<Record<string, unknown>> = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.toolCalls?.length) {
          msg.toolCalls.forEach((tc, idx) => {
            // Gemini expects `args` to be a Struct (object), not a JSON string.
            let argsObj: Record<string, unknown> = {};
            if (typeof tc.arguments === 'string' && tc.arguments.length > 0) {
              try { argsObj = JSON.parse(tc.arguments) as Record<string, unknown>; }
              catch { argsObj = {}; }
            } else if (tc.arguments && typeof tc.arguments === 'object') {
              argsObj = tc.arguments as Record<string, unknown>;
            }
            const part: Record<string, unknown> = {
              functionCall: {
                name: tc.name,
                args: argsObj,
              },
            };
            // Per Gemini docs: only the FIRST functionCall part in a model
            // response carries a thoughtSignature. Parallel siblings MUST NOT
            // include one. Preserve whatever the model gave us; if absent on
            // the first part, fall back to the documented validator-skip token.
            //   https://ai.google.dev/gemini-api/docs/thought-signatures
            const sig = tc.providerMetadata?.thoughtSignature;
            if (typeof sig === 'string' && sig.length > 0) {
              part.thoughtSignature = sig;
            } else if (idx === 0) {
              part.thoughtSignature = 'skip_thought_signature_validator';
            }
            parts.push(part);
          });
        }
        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
        continue;
      }

      // User message
      contents.push({
        role: 'user',
        parts: [{ text: msg.content }],
      });
    }

    return { contents, systemInstruction };
  }

  private formatTool(tool: ModelToolDefinition): Record<string, unknown> {
    return {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeGeminiSchema(tool.parameters) ?? { type: 'object', properties: {} },
    };
  }

  // ── Non-Streaming Response ──

  private handleResponse(data: Record<string, unknown>): ModelResponse {
    const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
    const candidate = candidates?.[0] ?? {};
    const contentObj = candidate.content as Record<string, unknown> | undefined;
    const parts = (contentObj?.parts ?? []) as Array<Record<string, unknown>>;

    let content = '';
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    for (const part of parts) {
      if (part.text) {
        content += part.text as string;
      }
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        const sig = part.thoughtSignature as string | undefined;
        toolCalls.push({
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          name: fc.name as string,
          arguments: JSON.stringify(fc.args ?? {}),
          ...(sig ? { providerMetadata: { thoughtSignature: sig } } : {}),
        });
      }
    }

    const usageMeta = data.usageMetadata as Record<string, number> | undefined;
    const usage: ModelUsage = {
      inputTokens: usageMeta?.promptTokenCount ?? 0,
      outputTokens: usageMeta?.candidatesTokenCount ?? 0,
      totalTokens: usageMeta?.totalTokenCount ?? 0,
    };

    const finishReason = this.mapFinishReason(
      candidate.finishReason as string | undefined,
    );

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: this.config.model,
      provider: this.name,
      usage,
      finishReason,
    };
  }

  // ── Streaming ──

  private async handleStream(
    res: Response,
    onToken: (token: string) => void,
  ): Promise<ModelResponse> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let content = '';
    const toolCalls = new Map<number, { id: string; name: string; args: string; thoughtSignature?: string }>();
    let finishReason: string | undefined;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;

        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
        const candidate = candidates?.[0];
        if (!candidate) continue;

        const contentObj = candidate.content as Record<string, unknown> | undefined;
        const parts = (contentObj?.parts ?? []) as Array<Record<string, unknown>>;

        for (const part of parts) {
          if (part.text) {
            const text = part.text as string;
            content += text;
            onToken(text);
          }
          if (part.functionCall) {
            const fc = part.functionCall as Record<string, unknown>;
            const sig = part.thoughtSignature as string | undefined;
            const idx = toolCalls.size;
            toolCalls.set(idx, {
              id: `call_${Math.random().toString(36).slice(2, 10)}`,
              name: fc.name as string,
              args: JSON.stringify(fc.args ?? {}),
              ...(sig ? { thoughtSignature: sig } : {}),
            });
          }
        }

        if (candidate.finishReason) {
          finishReason = candidate.finishReason as string;
        }

        // Usage metadata in stream chunks
        const usageMeta = chunk.usageMetadata as Record<string, number> | undefined;
        if (usageMeta) {
          promptTokens = usageMeta.promptTokenCount ?? promptTokens;
          completionTokens = usageMeta.candidatesTokenCount ?? completionTokens;
          totalTokens = usageMeta.totalTokenCount ?? totalTokens;
        }
      }
    }

    const mappedToolCalls = toolCalls.size > 0
      ? Array.from(toolCalls.values()).map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.args,
          ...(tc.thoughtSignature ? { providerMetadata: { thoughtSignature: tc.thoughtSignature } } : {}),
        }))
      : undefined;

    return {
      content,
      toolCalls: mappedToolCalls,
      model: this.config.model,
      provider: this.name,
      usage: {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        totalTokens,
      },
      finishReason: this.mapFinishReason(finishReason),
    };
  }

  // ── Helpers ──

  private mapFinishReason(
    reason: string | undefined,
  ): ModelResponse['finishReason'] {
    switch (reason) {
      case 'STOP': return 'stop';
      case 'MAX_TOKENS': return 'length';
      case 'SAFETY': return 'content_filter';
      case 'RECITATION': return 'content_filter';
      default:
        return reason === 'TOOL_CODE' || reason === 'MALFORMED_FUNCTION_CALL'
          ? 'tool_calls'
          : 'stop';
    }
  }
}

/**
 * Gemini's function-calling schema is a strict subset of OpenAPI 3.0. It
 * rejects fields commonly emitted by JSON-Schema generators (zod-to-json-schema,
 * etc.) such as `additionalProperties`, `$schema`, `$ref`, and `definitions`.
 * Strip them recursively so callers can pass standard JSON schemas without
 * having to know Gemini's quirks.
 */
function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeGeminiSchema(item));
  }
  if (!schema || typeof schema !== 'object') {
    return schema;
  }
  // Gemini supports only a subset of OpenAPI 3.0 fields. Use an allowlist so any
  // unknown JSON-Schema vocab (exclusiveMinimum, multipleOf, $ref, etc.) is
  // dropped silently instead of 400-ing the request.
  //   https://ai.google.dev/api/caching#Schema
  const ALLOW = new Set([
    'type', 'format', 'description', 'nullable', 'enum',
    'maxItems', 'minItems', 'properties', 'required', 'propertyOrdering',
    'items', 'anyOf', 'default', 'minimum', 'maximum',
    'minLength', 'maxLength', 'pattern', 'title',
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!ALLOW.has(key)) continue;
    // `properties` is a map of name→schema. Recurse on each VALUE but keep all
    // keys (they're user-defined property names, not schema vocab).
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [name, subSchema] of Object.entries(value as Record<string, unknown>)) {
        props[name] = sanitizeGeminiSchema(subSchema);
      }
      out[key] = props;
      continue;
    }
    out[key] = sanitizeGeminiSchema(value);
  }
  return out;
}
