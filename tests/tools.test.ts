import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/tools/ToolRegistry';
import { ToolExecutor } from '../src/tools/ToolExecutor';
import { ToolValidator } from '../src/tools/ToolValidator';
import { tool } from '../src/tools/tool';
import type { ToolContract, ToolCall, ToolContext } from '../src/types/tools';

function makeToolContract(overrides?: Partial<ToolContract>): ToolContract {
  return {
    name: 'test_tool',
    description: 'A test tool',
    input: z.object({ query: z.string() }),
    safetyClass: 'read',
    execute: vi.fn(async () => ({
      llmOutput: 'result',
      success: true,
    })),
    ...overrides,
  };
}

function makeToolCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: 'tc_1',
    name: 'test_tool',
    arguments: { query: 'hello' },
    ...overrides,
  };
}

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    runId: 'run_1',
    agentId: 'agent_1',
    turnIndex: 0,
    ...overrides,
  };
}

// ── ToolRegistry ──

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('registers and retrieves a tool', () => {
    const t = makeToolContract();
    registry.register(t);

    expect(registry.get('test_tool')).toBe(t);
    expect(registry.has('test_tool')).toBe(true);
  });

  it('throws on duplicate registration', () => {
    registry.register(makeToolContract());
    expect(() => registry.register(makeToolContract())).toThrow("already registered");
  });

  it('lists tools', () => {
    registry.register(makeToolContract({ name: 'a' }));
    registry.register(makeToolContract({ name: 'b' }));

    expect(registry.list()).toEqual(['a', 'b']);
  });

  it('getAll returns all tools', () => {
    registry.register(makeToolContract({ name: 'a' }));
    registry.register(makeToolContract({ name: 'b' }));

    expect(registry.getAll()).toHaveLength(2);
  });

  it('removes a tool', () => {
    registry.register(makeToolContract());
    expect(registry.remove('test_tool')).toBe(true);
    expect(registry.has('test_tool')).toBe(false);
  });

  it('returns false when removing non-existent tool', () => {
    expect(registry.remove('nope')).toBe(false);
  });

  it('clear removes all tools', () => {
    registry.register(makeToolContract({ name: 'a' }));
    registry.register(makeToolContract({ name: 'b' }));
    registry.clear();

    expect(registry.list()).toEqual([]);
  });
});

// ── ToolValidator ──

describe('ToolValidator', () => {
  const validator = new ToolValidator();

  it('validates correct input against Zod schema', () => {
    const t = makeToolContract({
      input: z.object({ query: z.string() }),
    });

    expect(validator.validateInput(t, { query: 'hello' })).toBeUndefined();
  });

  it('rejects invalid input against Zod schema', () => {
    const t = makeToolContract({
      input: z.object({ query: z.string() }),
    });

    const error = validator.validateInput(t, { query: 123 } as unknown as Record<string, unknown>);
    expect(error).toContain('validation failed');
  });

  it('validates required fields in JSON schema', () => {
    const t = makeToolContract({
      input: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    });

    expect(validator.validateInput(t, { name: 'test' })).toBeUndefined();
    expect(validator.validateInput(t, {})).toContain('Missing required field');
  });

  it('identifies safety classes requiring approval', () => {
    expect(validator.requiresApproval('read')).toBe(false);
    expect(validator.requiresApproval('write')).toBe(false);
    expect(validator.requiresApproval('financial')).toBe(true);
    expect(validator.requiresApproval('destructive')).toBe(true);
    expect(validator.requiresApproval('privileged')).toBe(true);
  });

  it('uses custom approval classes', () => {
    expect(validator.requiresApproval('write', ['write'])).toBe(true);
    expect(validator.requiresApproval('read', ['write'])).toBe(false);
  });
});

// ── tool() helper ──

describe('tool()', () => {
  it('creates a well-formed ToolContract', () => {
    const t = tool({
      name: 'greet',
      description: 'Greet a user',
      input: z.object({ name: z.string() }),
      safetyClass: 'read',
      async execute({ input }) {
        return { llmOutput: `Hello, ${input.name}!`, success: true };
      },
    });

    expect(t.name).toBe('greet');
    expect(t.description).toBe('Greet a user');
    expect(t.safetyClass).toBe('read');
    expect(typeof t.execute).toBe('function');
  });

  it('passes through optional fields', () => {
    const t = tool({
      name: 'test',
      description: 'test',
      input: z.object({}),
      safetyClass: 'write',
      execute: async () => ({ llmOutput: '', success: true }),
      timeoutMs: 5000,
      retries: 3,
      idempotent: true,
      permissions: ['admin'],
    });

    expect(t.timeoutMs).toBe(5000);
    expect(t.retries).toBe(3);
    expect(t.idempotent).toBe(true);
    expect(t.permissions).toEqual(['admin']);
  });
});

// ── ToolExecutor ──

describe('ToolExecutor', () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    executor = new ToolExecutor(registry);
  });

  it('executes a tool call successfully', async () => {
    const executeFn = vi.fn(async () => ({
      llmOutput: 'result',
      success: true,
    }));

    registry.register(makeToolContract({ execute: executeFn }));

    const result = await executor.execute(makeToolCall(), makeContext());

    expect(result.result.success).toBe(true);
    expect(result.result.llmOutput).toBe('result');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(executeFn).toHaveBeenCalledOnce();
  });

  it('returns error for unknown tool', async () => {
    const result = await executor.execute(
      makeToolCall({ name: 'unknown' }),
      makeContext(),
    );

    expect(result.result.success).toBe(false);
    expect(result.result.llmOutput).toContain('not found');
  });

  it('returns validation error for bad input', async () => {
    registry.register(makeToolContract({
      input: z.object({ query: z.string() }),
    }));

    const result = await executor.execute(
      makeToolCall({ arguments: { query: 123 } as unknown as Record<string, unknown> }),
      makeContext(),
    );

    expect(result.result.success).toBe(false);
    expect(result.result.llmOutput).toContain('Validation error');
  });

  it('retries on idempotent tool failure', async () => {
    let callCount = 0;
    const executeFn = vi.fn(async () => {
      callCount++;
      if (callCount < 3) throw new Error('transient');
      return { llmOutput: 'ok', success: true };
    });

    registry.register(makeToolContract({
      execute: executeFn,
      retries: 3,
      idempotent: true,
    }));

    const result = await executor.execute(makeToolCall(), makeContext());

    expect(result.result.success).toBe(true);
    expect(result.retryCount).toBe(2);
  });

  it('does not retry non-idempotent tools', async () => {
    const executeFn = vi.fn(async () => {
      throw new Error('fail');
    });

    registry.register(makeToolContract({
      execute: executeFn,
      retries: 3,
      idempotent: false,
    }));

    const result = await executor.execute(makeToolCall(), makeContext());

    expect(result.result.success).toBe(false);
    expect(executeFn).toHaveBeenCalledOnce();
  });

  it('executeAll runs multiple calls', async () => {
    registry.register(makeToolContract({ name: 'a', execute: async () => ({ llmOutput: '1', success: true }) }));
    registry.register(makeToolContract({ name: 'b', execute: async () => ({ llmOutput: '2', success: true }) }));

    const results = await executor.executeAll(
      [makeToolCall({ name: 'a' }), makeToolCall({ name: 'b' })],
      makeContext(),
    );

    expect(results).toHaveLength(2);
    expect(results[0].result.llmOutput).toBe('1');
    expect(results[1].result.llmOutput).toBe('2');
  });

  it('respects abort signal in executeAll', async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-abort

    registry.register(makeToolContract());

    const results = await executor.executeAll(
      [makeToolCall()],
      makeContext(),
      controller.signal,
    );

    expect(results[0].result.success).toBe(false);
    expect(results[0].result.llmOutput).toContain('aborted');
  });
});
