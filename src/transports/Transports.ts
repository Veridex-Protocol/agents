/**
 * @module Transports
 * Protocol transport interfaces for MCP, ACP, A2A, and generic HTTP.
 * These are the integration points for exposing and consuming tools/agents
 * across different protocol ecosystems.
 */

import type { ToolContract, ToolResult } from '../types/tools';

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

  /** Handle an incoming MCP tool call. */
  async handleToolCall(call: MCPToolCall): Promise<MCPToolResponse> {
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

/**
 * ACP Transport — Agent Communication Protocol bridge.
 * Enables Veridex agents to communicate with ACP-compatible agents.
 */
export class ACPTransport implements Transport {
  readonly protocol = 'acp';
  state: TransportState = 'disconnected';
  private capabilities: ACPCapability[] = [];
  private taskHandler?: (request: ACPTaskRequest) => Promise<ACPTaskResponse>;

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

  /** Handle an incoming ACP task request. */
  async handleTask(request: ACPTaskRequest): Promise<ACPTaskResponse> {
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
    _endpoint: string,
    request: ACPTaskRequest,
  ): Promise<ACPTaskResponse> {
    // In production, this would make an HTTP request to the remote agent
    // For now, return a placeholder that concrete implementations override
    return {
      taskId: request.taskId,
      status: 'failed',
      error: 'Remote ACP communication not yet connected',
    };
  }

  async connect(): Promise<void> {
    this.state = 'connected';
  }

  async disconnect(): Promise<void> {
    this.state = 'disconnected';
  }
}

// ── A2A Transport ──

/** A2A agent card (discovery). */
export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  capabilities: string[];
  authentication?: { type: string; schemes?: string[] };
  version: string;
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

/**
 * A2A Transport — Agent-to-Agent Protocol bridge.
 * Google's open protocol for agent interoperability.
 */
export class A2ATransport implements Transport {
  readonly protocol = 'a2a';
  state: TransportState = 'disconnected';
  private agentCard?: A2AAgentCard;
  private taskHandler?: (task: A2ATask) => Promise<A2ATaskResult>;

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

  /** Handle an incoming A2A task. */
  async handleTask(task: A2ATask): Promise<A2ATaskResult> {
    if (!this.taskHandler) {
      return { id: task.id, status: 'failed', error: 'No task handler registered' };
    }
    return this.taskHandler(task);
  }

  /** Send a task to a remote A2A agent. */
  async sendTask(
    _endpoint: string,
    task: A2ATask,
  ): Promise<A2ATaskResult> {
    return { id: task.id, status: 'failed', error: 'Remote A2A communication not yet connected' };
  }

  async connect(): Promise<void> {
    this.state = 'connected';
  }

  async disconnect(): Promise<void> {
    this.state = 'disconnected';
  }
}
