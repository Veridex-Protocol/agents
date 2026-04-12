/**
 * @packageDocumentation
 * @module AgentRegistryBridge
 * @description
 * Bidirectional bridge between the SDK AgentRuntime and the Veridex relayer
 * agent registry. Enables:
 *
 * 1. **SDK → Portal**: Auto-register SDK-created agents so they appear in the
 *    developer portal's Build > Agents page.
 * 2. **Portal → SDK**: Fetch agent definitions created via the portal so the
 *    SDK can hydrate a runtime from them.
 * 3. **Heartbeat**: Keep the relayer's `lastActiveAt` fresh while the agent
 *    is running.
 */

import type { AgentDefinition } from '../types/agent';

// ── Types mirroring relayer AgentRecord ──

export interface RegistryAgentRecord {
  id: string;
  appId: string;
  ownerId?: string;
  name: string;
  description?: string;
  environment: 'production' | 'staging' | 'development';
  status: 'active' | 'paused' | 'revoked';
  sessionCount?: number;
  activeSessionCount?: number;
  createdAt: number;
  updatedAt?: number;
  lastActiveAt?: number;
  metadata?: string;
}

export interface AgentRegistryConfig {
  /** Relayer base URL (e.g. https://relayer.veridex.network/api/v1) */
  relayerUrl: string;
  /** Workspace app ID */
  appId: string;
  /** API key for authentication */
  apiKey: string;
  /** Optional Bearer token (alternative auth) */
  authToken?: string;
  /** Agent environment label sent during registration */
  environment?: 'production' | 'staging' | 'development';
  /** Heartbeat interval in ms (0 = disabled, default 60_000) */
  heartbeatIntervalMs?: number;
  /** Whether to auto-register on bridge creation (default: true) */
  autoRegister?: boolean;
}

export class AgentRegistryBridge {
  private readonly config: AgentRegistryConfig;
  private registeredAgentId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AgentRegistryConfig) {
    this.config = config;
  }

  // ── Core auth header builder ──

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.authToken) {
      h['Authorization'] = `Bearer ${this.config.authToken}`;
    }
    h['x-api-key'] = this.config.apiKey;
    return h;
  }

  private url(path: string): string {
    const base = this.config.relayerUrl.replace(/\/+$/, '');
    return `${base}/apps/${encodeURIComponent(this.config.appId)}${path}`;
  }

  // ── SDK → Portal: Register agent ──

  /**
   * Register an SDK agent in the relayer so it appears in the developer portal.
   * If an agent with matching name + metadata.sdkAgentId already exists, returns
   * the existing record instead of creating a duplicate.
   */
  async register(definition: AgentDefinition): Promise<RegistryAgentRecord> {
    // Check for existing agent first (idempotent)
    const existing = await this.findByDefinitionId(definition.id);
    if (existing) {
      this.registeredAgentId = existing.id;
      this.startHeartbeat();
      return existing;
    }

    const res = await fetch(this.url('/agents'), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        name: definition.name,
        description: definition.metadata?.description as string ?? `SDK agent: ${definition.id}`,
        environment: this.config.environment ?? 'development',
        tags: ['sdk-registered'],
        metadata: {
          sdkAgentId: definition.id,
          model: definition.model,
          toolCount: definition.tools?.length ?? 0,
          maxTurns: definition.maxTurns,
          registeredFrom: 'sdk',
          registeredAt: Date.now(),
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Agent registration failed (${res.status}): ${body}`);
    }

    const data = await res.json() as { success: boolean; agent: RegistryAgentRecord };
    this.registeredAgentId = data.agent.id;
    this.startHeartbeat();
    return data.agent;
  }

  // ── Portal → SDK: Fetch agent config ──

  /**
   * List all agents registered in the portal workspace.
   */
  async listAgents(): Promise<RegistryAgentRecord[]> {
    const res = await fetch(this.url('/agents'), {
      method: 'GET',
      headers: this.headers,
    });

    if (!res.ok) {
      throw new Error(`Failed to list agents (${res.status})`);
    }

    const data = await res.json() as { agents: RegistryAgentRecord[] };
    return data.agents;
  }

  /**
   * Fetch a single agent record by its relayer ID.
   */
  async getAgent(agentId: string): Promise<RegistryAgentRecord | null> {
    const agents = await this.listAgents();
    return agents.find((a) => a.id === agentId) ?? null;
  }

  /**
   * Find an agent by its SDK definition ID stored in metadata.
   */
  async findByDefinitionId(sdkAgentId: string): Promise<RegistryAgentRecord | null> {
    const agents = await this.listAgents();
    return agents.find((a) => {
      if (!a.metadata) return false;
      try {
        const meta = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : a.metadata;
        return meta.sdkAgentId === sdkAgentId;
      } catch {
        return false;
      }
    }) ?? null;
  }

  /**
   * Convert a portal-created agent record into an AgentDefinition stub
   * that can be passed to `createAgent()` / `new AgentRuntime()`.
   *
   * The returned definition contains name, id, and metadata from the portal.
   * The caller must supply model config and tools separately since those
   * are not stored in the relayer.
   */
  toDefinitionStub(agent: RegistryAgentRecord): Partial<AgentDefinition> & { id: string; name: string } {
    let meta: Record<string, unknown> = {};
    try {
      meta = agent.metadata
        ? typeof agent.metadata === 'string' ? JSON.parse(agent.metadata) : agent.metadata
        : {};
    } catch { /* ignore */ }

    return {
      id: (meta.sdkAgentId as string) ?? agent.id,
      name: agent.name,
      metadata: {
        portalAgentId: agent.id,
        portalAppId: agent.appId,
        environment: agent.environment,
        description: agent.description,
        ...meta,
      },
    };
  }

  // ── Heartbeat ──

  /**
   * Send a heartbeat to update `lastActiveAt` on the relayer.
   */
  async heartbeat(): Promise<void> {
    if (!this.registeredAgentId) return;

    try {
      await fetch(this.url(`/agents/${this.registeredAgentId}`), {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify({
          metadata: JSON.stringify({ lastHeartbeat: Date.now() }),
        }),
      });
    } catch {
      // Heartbeat failures are non-fatal
    }
  }

  private startHeartbeat(): void {
    const interval = this.config.heartbeatIntervalMs ?? 60_000;
    if (interval <= 0 || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), interval);
    // Unref so timer doesn't keep Node alive
    if (typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      (this.heartbeatTimer as NodeJS.Timeout).unref();
    }
  }

  // ── Sync: Update status back to relayer ──

  /**
   * Update the registered agent's status in the relayer.
   */
  async updateStatus(status: 'active' | 'paused' | 'revoked'): Promise<void> {
    if (!this.registeredAgentId) return;

    await fetch(this.url(`/agents/${this.registeredAgentId}`), {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ status }),
    });
  }

  // ── Lifecycle ──

  /** Get the relayer agent ID for this bridge (null if not yet registered). */
  getRegisteredAgentId(): string | null {
    return this.registeredAgentId;
  }

  /** Stop heartbeat and clean up. */
  dispose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
