/**
 * Tests for Phase 1 wiring gaps:
 * 1. requireVerifiedEnvelope policy rule
 * 2. Transport PEP wiring into MCP/ACP/A2A transports
 * 3. Identity metadata flowing into PolicyEngine via runtime
 */
import { describe, it, expect } from 'vitest';
import {
  requireVerifiedEnvelope,
  PolicyEngine,
  MCPServerTransport,
  ACPTransport,
  A2ATransport,
  TransportBoundaryPEP,
} from '../src';

// ── requireVerifiedEnvelope ──

describe('requireVerifiedEnvelope', () => {
  const rule = requireVerifiedEnvelope(0.6);
  const baseCtx = {
    runId: 'r-1',
    agentId: 'agent-1',
    turnIndex: 0,
    proposal: { type: 'tool_call' as const, toolCalls: [{ name: 'foo', arguments: {} }] },
  };

  it('flags when no envelope present', async () => {
    const result = await rule.evaluate({ ...baseCtx });
    expect(result.verdict).toBe('flag');
    expect(result.riskContribution).toBe(0.6);
    expect(result.reason).toContain('No response envelope');
  });

  it('flags at half risk when envelope present but no integrity binding', async () => {
    const result = await rule.evaluate({
      ...baseCtx,
      metadata: { responseEnvelope: { version: '1.0' } },
    });
    expect(result.verdict).toBe('flag');
    expect(result.riskContribution).toBe(0.3);
    expect(result.reason).toContain('no integrity binding');
  });

  it('passes when both envelope and integrity binding present', async () => {
    const result = await rule.evaluate({
      ...baseCtx,
      metadata: {
        responseEnvelope: { version: '1.0' },
        integrityBinding: { definitionHash: 'abc', agentChecksum: 'def' },
      },
    });
    expect(result.verdict).toBe('pass');
    expect(result.riskContribution).toBe(0);
  });

  it('integrates with PolicyEngine', async () => {
    const engine = new PolicyEngine();
    engine.register(requireVerifiedEnvelope(0.5));
    const decision = await engine.evaluate({
      ...baseCtx,
    });
    expect(decision.verdict).toBe('flag');
    expect(decision.riskScore).toBeGreaterThan(0);
  });
});

// ── Transport PEP wiring ──

describe('Transport PEP wiring', () => {
  const strictPEP = new TransportBoundaryPEP({
    requireIdentity: true,
    trustedIssuers: ['veridex'],
  });

  const allowingPEP = new TransportBoundaryPEP({
    requireIdentity: false,
    requireIntegrity: false,
  });

  const validContext = {
    callerIdentity: {
      issuer: 'veridex',
      subject: 'agent-1',
      audience: 'service',
      scopes: [],
      issuedAt: Date.now(),
    },
    transport: {
      protocol: 'mcp' as const,
      endpoint: 'https://api.example.com',
      authenticated: true,
      authMethod: 'bearer' as const,
    },
  };

  const noIdentityContext = {
    transport: {
      protocol: 'mcp' as const,
      endpoint: 'https://api.example.com',
      authenticated: false,
    },
  };

  describe('MCPServerTransport', () => {
    it('blocks tool call when PEP rejects', async () => {
      const mcp = new MCPServerTransport();
      mcp.setPEP(strictPEP);
      mcp.registerTools([]);
      const result = await mcp.handleToolCall(
        { name: 'test', arguments: {} },
        noIdentityContext,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      expect((result.content[0] as { text: string }).text).toContain('PEP blocked');
    });

    it('allows tool call when PEP passes', async () => {
      const mcp = new MCPServerTransport();
      mcp.setPEP(allowingPEP);
      mcp.onToolCall(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      const result = await mcp.handleToolCall(
        { name: 'test', arguments: {} },
        validContext,
      );
      expect(result.isError).toBeUndefined();
      expect((result.content[0] as { text: string }).text).toBe('ok');
    });

    it('skips PEP when no context provided', async () => {
      const mcp = new MCPServerTransport();
      mcp.setPEP(strictPEP);
      mcp.onToolCall(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      const result = await mcp.handleToolCall({ name: 'test', arguments: {} });
      expect((result.content[0] as { text: string }).text).toBe('ok');
    });

    it('records lastPEPResult', async () => {
      const mcp = new MCPServerTransport();
      mcp.setPEP(allowingPEP);
      mcp.onToolCall(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      await mcp.handleToolCall({ name: 'test', arguments: {} }, validContext);
      expect(mcp.lastPEPResult).toBeDefined();
      expect(mcp.lastPEPResult!.allowed).toBe(true);
    });
  });

  describe('ACPTransport', () => {
    it('blocks task when PEP rejects', async () => {
      const acp = new ACPTransport();
      acp.setPEP(strictPEP);
      const result = await acp.handleTask(
        { taskId: 't-1', capability: 'test', input: {} },
        noIdentityContext,
      );
      expect(result.status).toBe('failed');
      expect(result.error).toContain('PEP blocked');
    });

    it('allows task when PEP passes', async () => {
      const acp = new ACPTransport();
      acp.setPEP(allowingPEP);
      acp.onTask(async (req) => ({ taskId: req.taskId, status: 'completed', output: 'done' }));
      const result = await acp.handleTask(
        { taskId: 't-1', capability: 'test', input: {} },
        validContext,
      );
      expect(result.status).toBe('completed');
    });
  });

  describe('A2ATransport', () => {
    it('blocks task when PEP rejects', async () => {
      const a2a = new A2ATransport();
      a2a.setPEP(strictPEP);
      const result = await a2a.handleTask(
        { id: 'a-1', input: { text: 'hello' } },
        noIdentityContext,
      );
      expect(result.status).toBe('failed');
      expect(result.error).toContain('PEP blocked');
    });

    it('allows task when PEP passes', async () => {
      const a2a = new A2ATransport();
      a2a.setPEP(allowingPEP);
      a2a.onTask(async (task) => ({ id: task.id, status: 'completed', output: { text: 'done' } }));
      const result = await a2a.handleTask(
        { id: 'a-1', input: { text: 'hello' } },
        validContext,
      );
      expect(result.status).toBe('completed');
    });
  });
});
