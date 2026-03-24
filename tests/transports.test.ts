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

  it('sendTask returns placeholder error', async () => {
    const response = await transport.sendTask('https://example.com', {
      taskId: 'task_1',
      capability: 'test',
      input: {},
    });
    expect(response.status).toBe('failed');
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
});
