import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../src/memory/InMemoryStore';
import { createMemoryTools } from '../src/memory/MemoryTools';
import type { ToolContract } from '../src/types/tools';

function findTool(tools: ToolContract[], name: string): ToolContract {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe('createMemoryTools', () => {
  let store: InMemoryStore;
  let tools: ToolContract[];

  beforeEach(() => {
    store = new InMemoryStore();
    tools = createMemoryTools({ store });
  });

  it('exposes the three Letta-style memory tools', () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['memory_archive', 'memory_insert', 'memory_replace']);
  });

  it('memory_insert writes an entry and reports its id', async () => {
    const insert = findTool(tools, 'memory_insert');
    const res = await insert.execute({
      input: { tier: 'semantic', content: 'sky is blue', tags: ['fact'], confidence: 0.9, scope: 'agent', ttlMs: 0 },
      context: { runId: 'r', agentId: 'a', turnIndex: 0 },
    });
    expect(res.success).toBe(true);
    expect(res.data).toBeDefined();
    const id = (res.data as { id: string }).id;
    const entry = (await store.read(id))!;
    expect(entry.content).toBe('sky is blue');
    expect(entry.tier).toBe('semantic');
    expect(entry.tags).toContain('fact');
  });

  it('memory_replace patches content and tags by id', async () => {
    const insert = findTool(tools, 'memory_insert');
    const replace = findTool(tools, 'memory_replace');
    const ins = await insert.execute({
      input: { tier: 'semantic', content: 'old', tags: [], confidence: 0.5, scope: 'agent', ttlMs: 0 },
      context: { runId: 'r', agentId: 'a', turnIndex: 0 },
    });
    const id = (ins.data as { id: string }).id;
    const res = await replace.execute({
      input: { id, content: 'new', tags: ['updated'], confidence: 0.95 },
      context: { runId: 'r', agentId: 'a', turnIndex: 0 },
    });
    expect(res.success).toBe(true);
    const updated = (await store.read(id))!;
    expect(updated.content).toBe('new');
    expect(updated.tags).toEqual(['updated']);
    expect(updated.confidence).toBeCloseTo(0.95);
  });

  it('memory_replace reports memory_not_found when id is unknown', async () => {
    const replace = findTool(tools, 'memory_replace');
    const res = await replace.execute({
      input: { id: 'nope', content: 'x' },
      context: { runId: 'r', agentId: 'a', turnIndex: 0 },
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('memory_not_found');
  });

  it('memory_archive soft-archives by tagging and dropping confidence', async () => {
    const insert = findTool(tools, 'memory_insert');
    const archive = findTool(tools, 'memory_archive');
    const ins = await insert.execute({
      input: { tier: 'semantic', content: 'thing', tags: ['fact'], confidence: 0.9, scope: 'agent', ttlMs: 0 },
      context: { runId: 'r', agentId: 'a', turnIndex: 0 },
    });
    const id = (ins.data as { id: string }).id;
    const res = await archive.execute({
      input: { id, reason: 'superseded' },
      context: { runId: 'r', agentId: 'a', turnIndex: 0 },
    });
    expect(res.success).toBe(true);
    const after = (await store.read(id))!;
    expect(after.tags).toContain('archived');
    expect(after.tags).toContain('fact');
    expect(after.confidence).toBeLessThanOrEqual(0.1);
  });

  it('memory_archive returns memory_not_found for unknown ids', async () => {
    const res = await findTool(tools, 'memory_archive').execute({
      input: { id: 'nope' },
      context: { runId: 'r', agentId: 'a', turnIndex: 0 },
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('memory_not_found');
  });

  it('all memory tools declare safetyClass="write"', () => {
    for (const t of tools) {
      expect(t.safetyClass).toBe('write');
    }
  });
});
