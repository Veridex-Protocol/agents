import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPlanningTools, type TodoEntry } from '../src/tools/PlanningTools';
import { createFilesystemTools } from '../src/tools/FilesystemTools';
import { createSubagentTools, type SubagentEntry, type SubagentExecutor } from '../src/tools/SubagentTools';
import type { ToolContract, ToolResult } from '../src/types/tools';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


// ══════════════════════════════════════════════════════════════════════════════
// PlanningTools
// ══════════════════════════════════════════════════════════════════════════════

describe('PlanningTools', () => {
  let writeTodo: ToolContract;
  let listTodos: ToolContract;

  beforeEach(() => {
    [writeTodo, listTodos] = createPlanningTools();
  });

  it('creates todos and lists them', async () => {
    const writeResult = await writeTodo.execute({
      input: {
        todos: [
          { content: 'Research API design', status: 'pending' },
          { content: 'Implement endpoints', status: 'pending' },
        ],
      },
    } as any);

    expect(writeResult.success).toBe(true);
    expect(writeResult.llmOutput).toContain('Updated 2 todo(s)');

    const listResult = await listTodos.execute({
      input: {},
    } as any);

    expect(listResult.success).toBe(true);
    expect(listResult.llmOutput).toContain('Research API design');
    expect(listResult.llmOutput).toContain('Implement endpoints');
  });

  it('updates an existing todo by id', async () => {
    // Create
    await writeTodo.execute({
      input: {
        todos: [{ id: 'task-1', content: 'Draft proposal', status: 'pending' }],
      },
    } as any);

    // Update
    const updateResult = await writeTodo.execute({
      input: {
        todos: [{ id: 'task-1', content: 'Draft proposal', status: 'completed' }],
      },
    } as any);

    expect(updateResult.success).toBe(true);
    expect(updateResult.llmOutput).toContain('completed');

    const listResult = await listTodos.execute({
      input: {},
    } as any);

    expect(listResult.llmOutput).toContain('completed');
    expect(listResult.llmOutput).toContain('Draft proposal');
  });

  it('filters by status', async () => {
    await writeTodo.execute({
      input: {
        todos: [
          { content: 'Task A', status: 'pending' },
          { content: 'Task B', status: 'completed' },
          { content: 'Task C', status: 'in_progress' },
        ],
      },
    } as any);

    const pendingResult = await listTodos.execute({
      input: { status: 'pending' },
    } as any);

    expect(pendingResult.success).toBe(true);
    expect(pendingResult.llmOutput).toContain('Task A');
    expect(pendingResult.llmOutput).not.toContain('Task B');
    expect(pendingResult.llmOutput).not.toContain('Task C');
  });

  it('returns empty message when no todos', async () => {
    const result = await listTodos.execute({
      input: {},
    } as any);

    expect(result.success).toBe(true);
    expect(result.llmOutput).toContain('No todos found');
  });

  it('exposes correct tool metadata', () => {
    expect(writeTodo.name).toBe('write_todo');
    expect(writeTodo.safetyClass).toBe('write');
    expect(listTodos.name).toBe('list_todos');
    expect(listTodos.safetyClass).toBe('read');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// FilesystemTools
// ══════════════════════════════════════════════════════════════════════════════

describe('FilesystemTools', () => {
  let tmpDir: string;
  let tools: ToolContract[];
  let fileRead: ToolContract;
  let fileWrite: ToolContract;
  let fileEdit: ToolContract;
  let fileSearch: ToolContract;
  let fileGlob: ToolContract;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'veridex-fs-test-'));
    tools = createFilesystemTools({ rootDir: tmpDir });
    [fileRead, fileWrite, fileEdit, fileSearch, fileGlob] = tools;
  });

  it('creates all 5 filesystem tools', () => {
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual([
      'file_read', 'file_write', 'file_edit', 'file_search', 'file_glob',
    ]);
  });

  it('file_write creates a file and file_read reads it', async () => {
    const writeResult = await fileWrite.execute({
      input: { path: 'hello.txt', content: 'Hello, world!', mode: 'overwrite' },
    } as any);

    expect(writeResult.success).toBe(true);
    expect(writeResult.llmOutput).toContain('13 bytes');

    const readResult = await fileRead.execute({
      input: { path: 'hello.txt', offset: 0, limit: 200 },
    } as any);

    expect(readResult.success).toBe(true);
    expect(readResult.llmOutput).toContain('Hello, world!');
  });

  it('file_write creates nested directories', async () => {
    const result = await fileWrite.execute({
      input: { path: 'deep/nested/dir/file.txt', content: 'deep file', mode: 'overwrite' },
    } as any);

    expect(result.success).toBe(true);

    const content = await readFile(join(tmpDir, 'deep/nested/dir/file.txt'), 'utf-8');
    expect(content).toBe('deep file');
  });

  it('file_write appends content', async () => {
    await fileWrite.execute({
      input: { path: 'log.txt', content: 'line1\n', mode: 'overwrite' },
    } as any);

    await fileWrite.execute({
      input: { path: 'log.txt', content: 'line2\n', mode: 'append' },
    } as any);

    const content = await readFile(join(tmpDir, 'log.txt'), 'utf-8');
    expect(content).toBe('line1\nline2\n');
  });

  it('file_edit applies a search-and-replace edit', async () => {
    await writeFile(join(tmpDir, 'code.ts'), 'const x = 1;\nconst y = 2;\n');

    const editResult = await fileEdit.execute({
      input: {
        path: 'code.ts',
        edits: [{ old_text: 'const x = 1;', new_text: 'const x = 42;' }],
      },
    } as any);

    expect(editResult.success).toBe(true);
    expect(editResult.llmOutput).toContain('Applied 1 edit');

    const content = await readFile(join(tmpDir, 'code.ts'), 'utf-8');
    expect(content).toContain('const x = 42;');
    expect(content).toContain('const y = 2;');
  });

  it('file_edit rejects ambiguous edits', async () => {
    await writeFile(join(tmpDir, 'dup.ts'), 'foo\nfoo\nbar\n');

    const editResult = await fileEdit.execute({
      input: {
        path: 'dup.ts',
        edits: [{ old_text: 'foo', new_text: 'baz' }],
      },
    } as any);

    // Should fail because 'foo' appears twice
    expect(editResult.success).toBe(false);
    expect(editResult.llmOutput).toContain('Multiple matches');
  });

  it('file_search finds text across files', async () => {
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src/a.ts'), 'export function hello() {}');
    await writeFile(join(tmpDir, 'src/b.ts'), 'export function world() {}');

    const result = await fileSearch.execute({
      input: { query: 'hello', glob: '**/*.ts' },
    } as any);

    expect(result.success).toBe(true);
    expect(result.llmOutput).toContain('a.ts');
    expect(result.llmOutput).toContain('hello');
    expect(result.llmOutput).not.toContain('world');
  });

  it('file_glob lists files matching a pattern', async () => {
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src/foo.ts'), '');
    await writeFile(join(tmpDir, 'src/bar.js'), '');
    await writeFile(join(tmpDir, 'README.md'), '');

    const result = await fileGlob.execute({
      input: { pattern: 'src/*.ts' },
    } as any);

    expect(result.success).toBe(true);
    expect(result.llmOutput).toContain('foo.ts');
    expect(result.llmOutput).not.toContain('bar.js');
    expect(result.llmOutput).not.toContain('README.md');
  });

  it('blocks path traversal', async () => {
    const result = await fileRead.execute({
      input: { path: '../../../etc/passwd', offset: 0, limit: 200 },
    } as any);

    expect(result.success).toBe(false);
    expect(result.llmOutput).toContain('traversal');
  });

  it('blocks banned extensions on write', async () => {
    const restricted = createFilesystemTools({
      rootDir: tmpDir,
      blockedExtensions: ['.exe', '.sh'],
    });

    const result = await restricted[1].execute({
      input: { path: 'hack.sh', content: '#!/bin/bash\nrm -rf /', mode: 'overwrite' },
    } as any);

    expect(result.success).toBe(false);
    expect(result.llmOutput).toContain('Blocked');
  });

  it('file_read returns line numbers', async () => {
    await writeFile(join(tmpDir, 'lines.txt'), 'alpha\nbeta\ngamma\ndelta\n');

    const result = await fileRead.execute({
      input: { path: 'lines.txt', offset: 1, limit: 2 },
    } as any);

    expect(result.success).toBe(true);
    // Lines 2-3 (offset 1 = skip first line)
    expect(result.llmOutput).toContain('beta');
    expect(result.llmOutput).toContain('gamma');
  });

  it('reports correct safety classes', () => {
    expect(fileRead.safetyClass).toBe('read');
    expect(fileWrite.safetyClass).toBe('write');
    expect(fileEdit.safetyClass).toBe('write');
    expect(fileSearch.safetyClass).toBe('read');
    expect(fileGlob.safetyClass).toBe('read');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SubagentTools
// ══════════════════════════════════════════════════════════════════════════════

describe('SubagentTools', () => {
  const mockExecutor: SubagentExecutor = vi.fn(async (def, prompt) => ({
    success: true,
    output: `Completed: ${prompt}`,
    metadata: { runId: 'child-run-1', turns: 3, status: 'completed' },
  }));

  const agents: SubagentEntry[] = [
    {
      name: 'researcher',
      description: 'Searches and summarizes information.',
      definition: {
        id: 'researcher-agent',
        name: 'Researcher',
        model: { provider: 'openai', model: 'gpt-4o-mini' },
        instructions: 'Research and summarize.',
      },
    },
    {
      name: 'coder',
      description: 'Writes and edits code.',
      definition: {
        id: 'coder-agent',
        name: 'Coder',
        model: { provider: 'openai', model: 'gpt-4o-mini' },
        instructions: 'Write clean code.',
      },
    },
  ];

  it('delegate_task calls the executor with correct args', async () => {
    const delegateTool = createSubagentTools({
      agents,
      executor: mockExecutor,
    });

    expect(delegateTool.name).toBe('delegate_task');
    expect(delegateTool.safetyClass).toBe('write');

    const result = await delegateTool.execute({
      input: {
        agent: 'researcher',
        task: 'Find trending repos',
      },
    } as any);

    expect(result.success).toBe(true);
    expect(result.llmOutput).toContain('Completed: Find trending repos');
    expect(mockExecutor).toHaveBeenCalledWith(
      agents[0].definition,
      'Find trending repos',
      expect.any(Object),
    );
  });

  it('passes context to the prompt', async () => {
    const executor: SubagentExecutor = vi.fn(async (_def, prompt) => ({
      success: true,
      output: prompt,
    }));

    const delegateTool = createSubagentTools({ agents, executor });

    const result = await delegateTool.execute({
      input: {
        agent: 'coder',
        task: 'Implement feature X',
        context: 'The codebase uses TypeScript and Vitest.',
      },
    } as any);

    expect(result.success).toBe(true);
    expect(result.llmOutput).toContain('Context:');
    expect(result.llmOutput).toContain('TypeScript and Vitest');
    expect(result.llmOutput).toContain('Implement feature X');
  });

  it('handles unknown agent name', async () => {
    const delegateTool = createSubagentTools({ agents, executor: mockExecutor });

    const result = await delegateTool.execute({
      input: { agent: 'nonexistent', task: 'Do something' },
    } as any);

    expect(result.success).toBe(false);
    expect(result.llmOutput).toContain('Unknown agent');
  });

  it('handles executor failure', async () => {
    const failingExecutor: SubagentExecutor = vi.fn(async () => ({
      success: false,
      output: 'Something went wrong',
      error: 'Model returned error',
    }));

    const delegateTool = createSubagentTools({ agents, executor: failingExecutor });

    const result = await delegateTool.execute({
      input: { agent: 'researcher', task: 'This will fail' },
    } as any);

    expect(result.success).toBe(false);
    expect(result.llmOutput).toContain('failed');
  });

  it('handles executor exceptions', async () => {
    const throwingExecutor: SubagentExecutor = vi.fn(async () => {
      throw new Error('Connection refused');
    });

    const delegateTool = createSubagentTools({ agents, executor: throwingExecutor });

    const result = await delegateTool.execute({
      input: { agent: 'coder', task: 'Crash test' },
    } as any);

    expect(result.success).toBe(false);
    expect(result.llmOutput).toContain('Connection refused');
  });

  it('handles timeout', async () => {
    const slowExecutor: SubagentExecutor = vi.fn(async () => {
      return new Promise((resolve) =>
        setTimeout(() => resolve({ success: true, output: 'done' }), 5000),
      );
    });

    const delegateTool = createSubagentTools({
      agents,
      executor: slowExecutor,
      timeout: 50, // 50ms timeout
    });

    const result = await delegateTool.execute({
      input: { agent: 'researcher', task: 'Slow task' },
    } as any);

    expect(result.success).toBe(false);
    expect(result.llmOutput).toContain('timed out');
  });

  it('describes available agents in tool schema', () => {
    const delegateTool = createSubagentTools({ agents, executor: mockExecutor });

    expect(delegateTool.description.toLowerCase()).toContain('delegate');
    expect(delegateTool.description.toLowerCase()).toContain('subagent');
  });
});
