/**
 * @module Transports
 * Protocol transport interfaces for MCP, ACP, A2A, and generic HTTP.
 * These are the integration points for exposing and consuming tools/agents
 * across different protocol ecosystems.
 */

import type { ToolContract } from '../types/tools';
import type { TransportBoundaryPEP, BoundaryPEPResult, TransportPEPContext } from './TransportBoundaryPEP';

type FetchLike = typeof fetch;

// ── Base Transport Interface ──

/** Transport connection state. */
export type TransportState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Base transport interface shared by all protocol transports. */
export interface Transport {
  /** Transport protocol identifier. */
  readonly protocol: string;
  /** Current connection state. */
  readonly state: TransportState;
  /** Connect to the transport endpoint. */
  connect(): Promise<void>;
  /** Disconnect from the transport. */
  disconnect(): Promise<void>;
}

export interface TransportAuthConfig {
  type: 'bearer' | 'api-key';
  token: string;
  headerName?: string;
}

export interface TransportRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

// ── MCP Transport ──

/** MCP tool definition matching the Model Context Protocol spec. */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP tool call request. */
export interface MCPToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** MCP tool call response. */
export interface MCPToolResponse {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

/**
 * MCP Server Transport — exposes Veridex tools as MCP-compatible tools.
 * Abstracts the MCP protocol so Veridex tools can be consumed by any MCP client.
 */
export class MCPServerTransport implements Transport {
  readonly protocol = 'mcp';
  state: TransportState = 'disconnected';
  private tools: Map<string, ToolContract> = new Map();
  private handler?: (call: MCPToolCall) => Promise<MCPToolResponse>;
  private pep?: TransportBoundaryPEP;
  /** Last PEP evaluation result (for testing/audit). */
  lastPEPResult?: BoundaryPEPResult;

  /** Set an optional transport boundary PEP for identity/integrity checks. */
  setPEP(pep: TransportBoundaryPEP): void {
    this.pep = pep;
  }

  /** Register Veridex tools to expose via MCP. */
  registerTools(tools: ToolContract[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /** Get MCP-formatted tool definitions. */
  getToolDefinitions(): MCPToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: typeof tool.input === 'object' && '_def' in tool.input
        ? { type: 'object' }
        : tool.input as Record<string, unknown>,
    }));
  }

  /** Set the handler for incoming MCP tool calls. */
  onToolCall(handler: (call: MCPToolCall) => Promise<MCPToolResponse>): void {
    this.handler = handler;
  }

  /** Handle an incoming MCP tool call. Runs PEP if configured. */
  async handleToolCall(call: MCPToolCall, transportContext?: TransportPEPContext): Promise<MCPToolResponse> {
    if (this.pep && transportContext) {
      const pepResult = this.pep.evaluate(transportContext);
      this.lastPEPResult = pepResult;
      if (!pepResult.allowed) {
        return {
          content: [{ type: 'text', text: `Transport PEP blocked: ${pepResult.reasons.join('; ')}` }],
          isError: true,
        };
      }
    }

    if (this.handler) {
      return this.handler(call);
    }

    const tool = this.tools.get(call.name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${call.name}` }], isError: true };
    }

    try {
      const result = await tool.execute({
        input: call.arguments,
        context: { runId: 'mcp', agentId: 'mcp-server', turnIndex: 0 },
      });
      return {
        content: [{ type: 'text', text: result.llmOutput }],
        isError: !result.success,
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Tool error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  async connect(): Promise<void> {
    this.state = 'connected';
  }

  async disconnect(): Promise<void> {
    this.state = 'disconnected';
  }
}

// ── ACP Transport ──

/** ACP agent capability advertisement. */
export interface ACPCapability {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  costEstimate?: { minUSD: number; maxUSD: number };
}

/** ACP task request. */
export interface ACPTaskRequest {
  taskId: string;
  capability: string;
  input: Record<string, unknown>;
  budget?: { maxUSD: number };
  requesterIdentity?: string;
}

/** ACP task response. */
export interface ACPTaskResponse {
  taskId: string;
  status: 'completed' | 'failed' | 'pending';
  output?: unknown;
  costUSD?: number;
  error?: string;
}

/** Configuration for ACP transport. */
export interface ACPTransportConfig {
  fetch?: FetchLike;
  timeoutMs?: number;
  auth?: TransportAuthConfig;
  headers?: Record<string, string>;
  invoker?: (
    endpoint: string,
    request: ACPTaskRequest,
    options?: TransportRequestOptions,
  ) => Promise<ACPTaskResponse>;
}

/**
 * ACP Transport — Agent Communication Protocol bridge.
 * Enables Veridex agents to communicate with ACP-compatible agents.
 */
export class ACPTransport implements Transport {
  readonly protocol = 'acp';
  state: TransportState = 'disconnected';
  private capabilities: ACPCapability[] = [];
  private taskHandler?: (request: ACPTaskRequest) => Promise<ACPTaskResponse>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly auth?: TransportAuthConfig;
  private readonly defaultHeaders?: Record<string, string>;
  private readonly invoker?: ACPTransportConfig['invoker'];
  private pep?: TransportBoundaryPEP;
  /** Last PEP evaluation result (for testing/audit). */
  lastPEPResult?: BoundaryPEPResult;

  constructor(config?: ACPTransportConfig) {
    this.fetchImpl = config?.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config?.timeoutMs ?? 30_000;
    this.auth = config?.auth;
    this.defaultHeaders = config?.headers;
    this.invoker = config?.invoker;
  }

  /** Set an optional transport boundary PEP for identity/integrity checks. */
  setPEP(pep: TransportBoundaryPEP): void {
    this.pep = pep;
  }

  /** Register capabilities this agent offers via ACP. */
  registerCapabilities(capabilities: ACPCapability[]): void {
    this.capabilities = [...capabilities];
  }

  /** Get advertised capabilities. */
  getCapabilities(): ACPCapability[] {
    return [...this.capabilities];
  }

  /** Set handler for incoming ACP task requests. */
  onTask(handler: (request: ACPTaskRequest) => Promise<ACPTaskResponse>): void {
    this.taskHandler = handler;
  }

  /** Handle an incoming ACP task request. Runs PEP if configured. */
  async handleTask(request: ACPTaskRequest, transportContext?: TransportPEPContext): Promise<ACPTaskResponse> {
    if (this.pep && transportContext) {
      const pepResult = this.pep.evaluate(transportContext);
      this.lastPEPResult = pepResult;
      if (!pepResult.allowed) {
        return {
          taskId: request.taskId,
          status: 'failed',
          error: `Transport PEP blocked: ${pepResult.reasons.join('; ')}`,
        };
      }
    }

    if (!this.taskHandler) {
      return {
        taskId: request.taskId,
        status: 'failed',
        error: 'No task handler registered',
      };
    }
    return this.taskHandler(request);
  }

  /** Send a task request to a remote ACP agent. */
  async sendTask(
    endpoint: string,
    request: ACPTaskRequest,
    options?: TransportRequestOptions,
  ): Promise<ACPTaskResponse> {
    if (this.state !== 'connected') {
      return {
        taskId: request.taskId,
        status: 'failed',
        error: 'Transport not connected',
      };
    }

    if (this.invoker) {
      return this.invoker(endpoint, request, options);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options?.timeoutMs ?? this.timeoutMs,
    );

    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: this.buildHeaders(options?.headers),
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      const payload = await this.safeJson(response);
      if (!response.ok) {
        return {
          taskId: request.taskId,
          status: 'failed',
          output: payload?.output,
          costUSD: typeof payload?.costUSD === 'number' ? payload.costUSD : undefined,
          error: typeof payload?.error === 'string'
            ? payload.error
            : `ACP request failed: HTTP ${response.status}`,
        };
      }

      return {
        taskId: typeof payload?.taskId === 'string' ? payload.taskId : request.taskId,
        status: this.normalizeACPStatus(payload?.status),
        output: payload?.output,
        costUSD: typeof payload?.costUSD === 'number' ? payload.costUSD : undefined,
        error: typeof payload?.error === 'string' ? payload.error : undefined,
      };
    } catch (err) {
      const message = err instanceof Error
        ? (err.name === 'AbortError' ? 'Request timed out' : err.message)
        : String(err);
      return {
        taskId: request.taskId,
        status: 'failed',
        error: `ACP request error: ${message}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async connect(): Promise<void> {
    this.state = 'connected';
  }

  async disconnect(): Promise<void> {
    this.state = 'disconnected';
  }

  private buildHeaders(extra?: Record<string, string>): Headers {
    const headers = new Headers({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(this.defaultHeaders ?? {}),
      ...(extra ?? {}),
    });

    if (this.auth?.type === 'bearer') {
      headers.set('Authorization', `Bearer ${this.auth.token}`);
    } else if (this.auth?.type === 'api-key') {
      headers.set(this.auth.headerName ?? 'X-API-Key', this.auth.token);
    }

    return headers;
  }

  private async safeJson(response: Response): Promise<Record<string, unknown> | null> {
    try {
      return await response.json() as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private normalizeACPStatus(status: unknown): ACPTaskResponse['status'] {
    if (status === 'completed' || status === 'failed' || status === 'pending') {
      return status;
    }
    return 'completed';
  }
}

// ── A2A Transport ──

/** A2A agent card (discovery). */
export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  capabilities?: string[];
  skills?: Array<{
    id?: string;
    name: string;
    description?: string;
    tags?: string[];
  }>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  authentication?: { type: string; schemes?: string[] };
  version: string;
  metadata?: Record<string, unknown>;
}

/** A2A task. */
export interface A2ATask {
  id: string;
  input: { text: string; attachments?: Array<{ name: string; content: string; mimeType: string }> };
  metadata?: Record<string, unknown>;
}

/** A2A task result. */
export interface A2ATaskResult {
  id: string;
  status: 'completed' | 'failed' | 'in_progress' | 'cancelled';
  output?: { text: string; attachments?: Array<{ name: string; content: string; mimeType: string }> };
  error?: string;
}

/** Configuration for A2A transport. */
export interface A2ATransportConfig {
  fetch?: FetchLike;
  timeoutMs?: number;
  auth?: TransportAuthConfig;
  headers?: Record<string, string>;
  rpcMethods?: string[];
}

/**
 * A2A Transport — Agent-to-Agent Protocol bridge.
 * Google's open protocol for agent interoperability.
 */
export class A2ATransport implements Transport {
  readonly protocol = 'a2a';
  state: TransportState = 'disconnected';
  private agentCard?: A2AAgentCard;
  private taskHandler?: (task: A2ATask) => Promise<A2ATaskResult>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly auth?: TransportAuthConfig;
  private readonly defaultHeaders?: Record<string, string>;
  private readonly rpcMethods: string[];
  private pep?: TransportBoundaryPEP;
  /** Last PEP evaluation result (for testing/audit). */
  lastPEPResult?: BoundaryPEPResult;

  constructor(config?: A2ATransportConfig) {
    this.fetchImpl = config?.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config?.timeoutMs ?? 30_000;
    this.auth = config?.auth;
    this.defaultHeaders = config?.headers;
    this.rpcMethods = config?.rpcMethods ?? ['message/send', 'tasks/send'];
  }

  /** Set an optional transport boundary PEP for identity/integrity checks. */
  setPEP(pep: TransportBoundaryPEP): void {
    this.pep = pep;
  }

  /** Set this agent's A2A agent card for discovery. */
  setAgentCard(card: A2AAgentCard): void {
    this.agentCard = card;
  }

  /** Get the agent card. */
  getAgentCard(): A2AAgentCard | undefined {
    return this.agentCard;
  }

  /** Set handler for incoming A2A tasks. */
  onTask(handler: (task: A2ATask) => Promise<A2ATaskResult>): void {
    this.taskHandler = handler;
  }

  /** Handle an incoming A2A task. Runs PEP if configured. */
  async handleTask(task: A2ATask, transportContext?: TransportPEPContext): Promise<A2ATaskResult> {
    if (this.pep && transportContext) {
      const pepResult = this.pep.evaluate(transportContext);
      this.lastPEPResult = pepResult;
      if (!pepResult.allowed) {
        return { id: task.id, status: 'failed', error: `Transport PEP blocked: ${pepResult.reasons.join('; ')}` };
      }
    }

    if (!this.taskHandler) {
      return { id: task.id, status: 'failed', error: 'No task handler registered' };
    }
    return this.taskHandler(task);
  }

  /**
   * Send a task to a remote A2A agent via JSON-RPC HTTP POST.
   * Uses `message/send` first and falls back to `tasks/send` for older servers.
   */
  async sendTask(
    endpoint: string,
    task: A2ATask,
    options?: TransportRequestOptions,
  ): Promise<A2ATaskResult> {
    if (this.state !== 'connected') {
      return { id: task.id, status: 'failed', error: 'Transport not connected' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options?.timeoutMs ?? this.timeoutMs,
    );

    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      for (const method of this.rpcMethods) {
        const response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: this.buildHeaders(options?.headers),
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: task.id,
            method,
            params: {
              taskId: task.id,
              metadata: task.metadata,
              message: {
                role: 'user',
                parts: [{ type: 'text', text: task.input.text }],
              },
            },
          }),
          signal: controller.signal,
        });

        const rpcResponse = await this.safeJson(response);
        const rpcError = rpcResponse?.error as Record<string, unknown> | undefined;

        if (this.isMethodNotSupported(rpcError)) {
          continue;
        }

        if (!response.ok) {
          return {
            id: task.id,
            status: 'failed',
            error: typeof rpcError?.message === 'string'
              ? rpcError.message
              : `A2A request failed: HTTP ${response.status}`,
          };
        }

        return this.normalizeA2AResult(
          task.id,
          (rpcResponse?.result ?? rpcResponse ?? {}) as Record<string, unknown>,
        );
      }

      return {
        id: task.id,
        status: 'failed',
        error: 'Remote A2A endpoint did not support any known RPC method',
      };
    } catch (err) {
      const message = err instanceof Error
        ? (err.name === 'AbortError' ? 'Request timed out' : err.message)
        : String(err);
      return {
        id: task.id,
        status: 'failed',
        error: `A2A request error: ${message}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fetch a remote agent's agent card from the A2A well-known discovery URLs.
   * Tries endpoint-scoped discovery first, then origin-scoped fallback.
   */
  async fetchAgentCard(endpoint: string): Promise<A2AAgentCard | null> {
    for (const url of this.resolveAgentCardUrls(endpoint)) {
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: this.buildHeaders(),
        });
        if (!response.ok) continue;

        const payload = await this.safeJson(response);
        if (!payload) continue;

        return payload as unknown as A2AAgentCard;
      } catch {
      }
    }

    return null;
  }

  async connect(): Promise<void> {
    this.state = 'connected';
  }

  async disconnect(): Promise<void> {
    this.state = 'disconnected';
  }

  private buildHeaders(extra?: Record<string, string>): Headers {
    const headers = new Headers({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(this.defaultHeaders ?? {}),
      ...(extra ?? {}),
    });

    if (this.auth?.type === 'bearer') {
      headers.set('Authorization', `Bearer ${this.auth.token}`);
    } else if (this.auth?.type === 'api-key') {
      headers.set(this.auth.headerName ?? 'X-API-Key', this.auth.token);
    }

    return headers;
  }

  private resolveAgentCardUrls(endpoint: string): string[] {
    if (endpoint.endsWith('agent-card.json')) {
      return [endpoint];
    }

    const withSlash = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
    const nested = new URL('.well-known/agent-card.json', withSlash).toString();
    const origin = new URL('/.well-known/agent-card.json', endpoint).toString();
    return nested === origin ? [nested] : [nested, origin];
  }

  private async safeJson(response: Response): Promise<Record<string, unknown> | null> {
    try {
      return await response.json() as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private isMethodNotSupported(error?: Record<string, unknown>): boolean {
    if (!error) return false;
    const code = typeof error.code === 'number' ? error.code : undefined;
    const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
    return code === -32601 || message.includes('method not found') || message.includes('not implemented');
  }

  private normalizeA2AResult(id: string, payload: Record<string, unknown>): A2ATaskResult {
    const status = this.normalizeA2AStatus(payload.status);
    const outputText = this.extractA2AText(payload);
    const attachments = this.extractA2AAttachments(payload);
    const error = typeof payload.error === 'string'
      ? payload.error
      : undefined;

    return {
      id: typeof payload.id === 'string' ? payload.id : id,
      status,
      output: outputText || attachments.length > 0
        ? {
            text: outputText,
            attachments: attachments.length > 0 ? attachments : undefined,
          }
        : undefined,
      error,
    };
  }

  private normalizeA2AStatus(status: unknown): A2ATaskResult['status'] {
    const raw = typeof status === 'string'
      ? status
      : typeof (status as { state?: string } | undefined)?.state === 'string'
        ? (status as { state: string }).state
        : 'completed';

    switch (raw) {
      case 'completed':
      case 'failed':
      case 'in_progress':
      case 'cancelled':
        return raw;
      case 'submitted':
      case 'working':
        return 'in_progress';
      default:
        return 'completed';
    }
  }

  private extractA2AText(payload: Record<string, unknown>): string {
    const output = payload.output as Record<string, unknown> | undefined;
    if (typeof output?.text === 'string') {
      return output.text;
    }

    const message = payload.message as Record<string, unknown> | undefined;
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    return parts
      .map((part) => part as Record<string, unknown>)
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n');
  }

  private extractA2AAttachments(
    payload: Record<string, unknown>,
  ): Array<{ name: string; content: string; mimeType: string }> {
    const output = payload.output as Record<string, unknown> | undefined;
    const outputAttachments = Array.isArray(output?.attachments) ? output.attachments : [];
    const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    const combined = [...outputAttachments, ...artifacts];

    return combined
      .map((attachment) => attachment as Record<string, unknown>)
      .filter((attachment) => typeof attachment.content === 'string')
      .map((attachment, index) => ({
        name: typeof attachment.name === 'string' ? attachment.name : `artifact_${index + 1}`,
        content: attachment.content as string,
        mimeType: typeof attachment.mimeType === 'string'
          ? attachment.mimeType
          : 'application/octet-stream',
      }));
  }
}
