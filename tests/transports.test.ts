import { describe, it, expect, beforeEach } from 'vitest';
import {
  MCPServerTransport,
  ACPTransport,
  A2ATransport,
} from '../src/transports';
import type { ToolContract } from '../src/types/tools';

function makeTool(name: string): ToolContract {
  return {
    name,
    description: `Tool: ${name}`,
    input: { type: 'object', properties: {} },
    safetyClass: 'read',
    execute: async () => ({ llmOutput: `${name} result`, success: true }),
  } as unknown as ToolContract;
}

describe('MCPServerTransport', () => {
  let transport: MCPServerTransport;

  beforeEach(() => {
    transport = new MCPServerTransport();
  });

  it('starts disconnected', () => {
    expect(transport.state).toBe('disconnected');
    expect(transport.protocol).toBe('mcp');
  });

  it('connects and disconnects', async () => {
    await transport.connect();
    expect(transport.state).toBe('connected');

    await transport.disconnect();
    expect(transport.state).toBe('disconnected');
  });

  it('registers tools and generates definitions', () => {
    transport.registerTools([makeTool('read'), makeTool('write')]);
    const defs = transport.getToolDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs[0].name).toBe('read');
    expect(defs[1].name).toBe('write');
  });

  it('handles tool calls with execute', async () => {
    transport.registerTools([makeTool('greet')]);

    const response = await transport.handleToolCall({
      name: 'greet',
      arguments: { name: 'Alice' },
    });

    expect(response.content[0].type).toBe('text');
    expect(response.isError).toBeFalsy();
  });

  it('returns error for unknown tools', async () => {
    const response = await transport.handleToolCall({
      name: 'unknown',
      arguments: {},
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Unknown tool');
  });

  it('uses custom handler when set', async () => {
    transport.onToolCall(async (call) => ({
      content: [{ type: 'text', text: `Custom: ${call.name}` }],
    }));

    const response = await transport.handleToolCall({
      name: 'anything',
      arguments: {},
    });

    expect(response.content[0].text).toBe('Custom: anything');
  });
});

describe('ACPTransport', () => {
  let transport: ACPTransport;

  beforeEach(() => {
    transport = new ACPTransport();
  });

  it('starts disconnected', () => {
    expect(transport.state).toBe('disconnected');
    expect(transport.protocol).toBe('acp');
  });

  it('connects and disconnects', async () => {
    await transport.connect();
    expect(transport.state).toBe('connected');
    await transport.disconnect();
    expect(transport.state).toBe('disconnected');
  });

  it('registers and retrieves capabilities', () => {
    transport.registerCapabilities([
      {
        name: 'transfer',
        description: 'Transfer tokens',
        inputSchema: { type: 'object' },
        costEstimate: { minUSD: 0.01, maxUSD: 0.1 },
      },
    ]);

    const caps = transport.getCapabilities();
    expect(caps).toHaveLength(1);
    expect(caps[0].name).toBe('transfer');
  });

  it('handles task requests with handler', async () => {
    transport.onTask(async (req) => ({
      taskId: req.taskId,
      status: 'completed',
      output: { result: 'done' },
    }));

    const response = await transport.handleTask({
      taskId: 'task_1',
      capability: 'transfer',
      input: { to: '0x123' },
    });

    expect(response.status).toBe('completed');
    expect(response.taskId).toBe('task_1');
  });

  it('fails without handler', async () => {
    const response = await transport.handleTask({
      taskId: 'task_1',
      capability: 'transfer',
      input: {},
    });

    expect(response.status).toBe('failed');
    expect(response.error).toContain('No task handler');
  });

  it('sendTask returns error when not connected', async () => {
    const response = await transport.sendTask('https://example.com', {
      taskId: 'task_1',
      capability: 'test',
      input: {},
    });
    expect(response.status).toBe('failed');
    expect(response.error).toContain('not connected');
  });

  it('sendTask handles network errors gracefully when connected', async () => {
    await transport.connect();
    // Using an unreachable address to trigger fetch error
    const response = await transport.sendTask('http://0.0.0.0:1/unreachable', {
      taskId: 'task_net',
      capability: 'test',
      input: {},
    });
    expect(response.status).toBe('failed');
    expect(response.error).toContain('ACP request error');
    expect(response.taskId).toBe('task_net');
  });

  it('sends HTTP requests with bearer auth and parses responses', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const configured = new ACPTransport({
      auth: { type: 'bearer', token: 'my-token' },
      headers: { 'X-Custom': 'value' },
      fetch: async (input, init) => {
        requests.push({ input, init });
        return new Response(JSON.stringify({
          taskId: 'task_http',
          status: 'completed',
          output: { ok: true },
          costUSD: 1.25,
        }), { status: 200 });
      },
    });

    await configured.connect();
    const result = await configured.sendTask('https://remote.example/acp', {
      taskId: 'task_http',
      capability: 'transfer',
      input: { amount: 1 },
    });

    const headers = requests[0].init?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer my-token');
    expect(headers.get('X-Custom')).toBe('value');
    expect(result.status).toBe('completed');
    expect(result.costUSD).toBe(1.25);
  });

  it('accepts config with auth and custom headers', () => {
    const configured = new ACPTransport({
      timeoutMs: 5000,
      auth: { type: 'bearer', token: 'my-token' },
      headers: { 'X-Custom': 'value' },
    });
    expect(configured.protocol).toBe('acp');
  });
});

describe('A2ATransport', () => {
  let transport: A2ATransport;

  beforeEach(() => {
    transport = new A2ATransport();
  });

  it('starts disconnected', () => {
    expect(transport.state).toBe('disconnected');
    expect(transport.protocol).toBe('a2a');
  });

  it('connects and disconnects', async () => {
    await transport.connect();
    expect(transport.state).toBe('connected');
    await transport.disconnect();
    expect(transport.state).toBe('disconnected');
  });

  it('sets and gets agent card', () => {
    transport.setAgentCard({
      name: 'My Agent',
      description: 'A test agent',
      url: 'https://example.com/agent',
      capabilities: ['transfer', 'query'],
      version: '1.0.0',
    });

    const card = transport.getAgentCard();
    expect(card?.name).toBe('My Agent');
    expect(card?.capabilities).toHaveLength(2);
  });

  it('handles incoming tasks with handler', async () => {
    transport.onTask(async (task) => ({
      id: task.id,
      status: 'completed',
      output: { text: `Handled: ${task.input.text}` },
    }));

    const result = await transport.handleTask({
      id: 'task_1',
      input: { text: 'Do something' },
    });

    expect(result.status).toBe('completed');
  });

  it('fails without handler', async () => {
    const result = await transport.handleTask({
      id: 'task_1',
      input: { text: 'hello' },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('No task handler');
  });

  it('returns undefined when no agent card set', () => {
    expect(transport.getAgentCard()).toBeUndefined();
  });

  it('sendTask returns error when not connected', async () => {
    const result = await transport.sendTask('https://example.com', {
      id: 'task_1',
      input: { text: 'hello' },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('not connected');
  });

  it('sendTask handles network errors gracefully when connected', async () => {
    await transport.connect();
    const result = await transport.sendTask('http://0.0.0.0:1/unreachable', {
      id: 'task_net',
      input: { text: 'hello' },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('A2A request error');
    expect(result.id).toBe('task_net');
  });

  it('falls back from message/send to tasks/send for older servers', async () => {
    const rpcMethods: string[] = [];
    const configured = new A2ATransport({
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        rpcMethods.push(body.method);

        if (body.method === 'message/send') {
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32601, message: 'Method not found' },
          }), { status: 200 });
        }

        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          result: {
            id: 'task_rpc',
            status: { state: 'completed' },
            message: {
              parts: [{ type: 'text', text: 'Handled remotely' }],
            },
          },
        }), { status: 200 });
      },
    });

    await configured.connect();
    const result = await configured.sendTask('https://remote.example/a2a', {
      id: 'task_rpc',
      input: { text: 'hello' },
    });

    expect(rpcMethods).toEqual(['message/send', 'tasks/send']);
    expect(result.status).toBe('completed');
    expect(result.output?.text).toBe('Handled remotely');
  });

  it('fetches agent cards from endpoint-scoped well-known paths', async () => {
    const configured = new A2ATransport({
      fetch: async (input) => {
        expect(String(input)).toContain('/a2a/check_prime_agent/.well-known/agent-card.json');
        return new Response(JSON.stringify({
          name: 'Prime Agent',
          description: 'Checks prime numbers',
          url: 'https://remote.example/a2a/check_prime_agent',
          version: '1.0.0',
        }), { status: 200 });
      },
    });

    const card = await configured.fetchAgentCard('https://remote.example/a2a/check_prime_agent');
    expect(card?.name).toBe('Prime Agent');
  });

  it('accepts config with auth and timeout', () => {
    const configured = new A2ATransport({
      timeoutMs: 5000,
      auth: { type: 'bearer', token: 'my-token' },
      headers: { 'X-Custom': 'value' },
    });
    expect(configured.protocol).toBe('a2a');
  });
});
