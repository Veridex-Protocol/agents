import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AgentRuntime } from '../src/runtime/AgentRuntime';
import { tool } from '../src/tools/tool';
import {
  summariseToolForCatalog,
  renderDisclosedCatalog,
  renderFullToolDetail,
  createLoadToolBuiltin,
} from '../src/tools/ToolDisclosureTools';
import type {
  ModelProvider,
  ModelResponse,
  ModelMessage,
  ModelCompletionOptions,
} from '../src/types/models';
import type { AgentDefinition } from '../src/types/agent';

function mkProvider(responses: ModelResponse[]): ModelProvider {
  let i = 0;
  return {
    name: 'mock',
    complete: vi.fn(async (_m: ModelMessage[], _o?: ModelCompletionOptions) => {
      const r = responses[i] ?? responses[responses.length - 1];
      i++;
      return r;
    }),
  };
}

const baseResponse: ModelResponse = {
  content: 'done',
  model: 'mock',
  provider: 'mock',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  finishReason: 'stop',
};

function makeTool(name: string, summary?: string, description = 'long\nverbose\ndescription') {
  return tool({
    name,
    description,
    guidance: summary ? { summary } : undefined,
    input: z.object({}),
    safetyClass: 'read',
    async execute() {
      return { success: true, llmOutput: 'ok' };
    },
  });
}

describe('summariseToolForCatalog', () => {
  it('prefers explicit guidance.summary', () => {
    const t = makeTool('a', 'A short summary.');
    expect(summariseToolForCatalog(t)).toBe('A short summary.');
  });

  it('falls back to the first line of description', () => {
    const t = makeTool('b', undefined, 'First line.\nSecond line.');
    expect(summariseToolForCatalog(t)).toBe('First line.');
  });

  it('truncates overly long fallbacks', () => {
    const long = 'x'.repeat(200);
    const t = makeTool('c', undefined, long);
    const result = summariseToolForCatalog(t);
    expect(result.length).toBe(120);
    expect(result.endsWith('...')).toBe(true);
  });
});

describe('renderDisclosedCatalog', () => {
  it('returns one short line per tool plus a load_tool hint', () => {
    const tools = [
      makeTool('alpha', 'Does alpha things.'),
      makeTool('beta', 'Does beta things.'),
    ];
    const out = renderDisclosedCatalog(tools);
    expect(out).toContain('- alpha [read] — Does alpha things.');
    expect(out).toContain('- beta [read] — Does beta things.');
    expect(out).toContain('load_tool');
    // Should NOT contain the long description body.
    expect(out).not.toContain('verbose');
  });

  it('returns empty string for an empty catalog', () => {
    expect(renderDisclosedCatalog([])).toBe('');
  });
});

describe('renderFullToolDetail', () => {
  it('includes name, safety class, description, and permissions', () => {
    const t = tool({
      name: 'thing',
      description: 'does the thing',
      input: z.object({}),
      safetyClass: 'privileged',
      permissions: ['fs:write'],
      timeoutMs: 5000,
      idempotent: true,
      async execute() {
        return { success: true, llmOutput: 'ok' };
      },
    });
    const out = renderFullToolDetail(t);
    expect(out).toContain('Tool: thing [privileged]');
    expect(out).toContain('does the thing');
    expect(out).toContain('Permissions: fs:write');
    expect(out).toContain('Timeout: 5000ms');
    expect(out).toContain('Idempotent: true');
  });
});

describe('createLoadToolBuiltin', () => {
  it('returns full detail for a known tool', async () => {
    const target = makeTool('alpha', 'Alpha summary.');
    const loader = createLoadToolBuiltin((name) => (name === 'alpha' ? target : undefined));
    const result = await loader.execute({
      input: { name: 'alpha' },
      context: { runId: 'r', agentId: 'a', turnIndex: 0 },
    });
    expect(result.success).toBe(true);
    expect(result.llmOutput).toContain('Tool: alpha [read]');
  });

  it('returns a structured error for unknown tools', async () => {
    const loader = createLoadToolBuiltin(() => undefined);
    const result = await loader.execute({
      input: { name: 'missing' },
      context: { runId: 'r', agentId: 'a', turnIndex: 0 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('tool_not_found');
  });
});

describe('AgentRuntime progressiveToolDisclosure', () => {
  function definition(tools: ReturnType<typeof makeTool>[]): AgentDefinition {
    return {
      id: 'disc-agent',
      name: 'Disclosure Agent',
      model: { provider: 'mock', model: 'mock' },
      instructions: 'be brief',
      tools,
    };
  }

  it('auto-registers load_tool when enabled', () => {
    const runtime = new AgentRuntime(definition([makeTool('alpha', 'A.')]), {
      modelProviders: { mock: mkProvider([baseResponse]) },
      progressiveToolDisclosure: true,
    });
    expect(runtime.tools.get('load_tool')).toBeDefined();
  });

  it('does NOT register load_tool by default', () => {
    const runtime = new AgentRuntime(definition([makeTool('alpha', 'A.')]), {
      modelProviders: { mock: mkProvider([baseResponse]) },
    });
    expect(runtime.tools.get('load_tool')).toBeUndefined();
  });

  it('produces a shorter tool catalog with disclosure on', () => {
    const longDesc = (label: string) =>
      `Detailed ${label} description with several paragraphs of content. ` +
      `It explains every input field, edge case, retry semantics, error envelope, and downstream side effect. ` +
      `It also references related tools and integration notes that bloat the prompt.`;
    const tools = [
      makeTool('alpha', 'Alpha summary.', longDesc('alpha')),
      makeTool('beta', 'Beta summary.', longDesc('beta')),
      makeTool('gamma', 'Gamma summary.', longDesc('gamma')),
    ];
    const off = new AgentRuntime(definition(tools), {
      modelProviders: { mock: mkProvider([baseResponse]) },
    });
    const on = new AgentRuntime(definition(tools), {
      modelProviders: { mock: mkProvider([baseResponse]) },
      progressiveToolDisclosure: true,
    });
    // Access the private serializer via a typed cast.
    const offCatalog = (off as unknown as { serializeToolCatalog(): string }).serializeToolCatalog();
    const onCatalog = (on as unknown as { serializeToolCatalog(): string }).serializeToolCatalog();
    expect(onCatalog.length).toBeLessThan(offCatalog.length);
    expect(onCatalog).toContain('load_tool');
    expect(onCatalog).not.toContain('Detailed alpha description');
  });
});
