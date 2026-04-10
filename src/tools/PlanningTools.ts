/**
 * @module PlanningTools
 * @description
 * Task planning and tracking tools for agents.
 *
 * Provides `write_todo` and `list_todos` tools that store tasks in
 * the working memory tier.  Unlike middleware-injected planning (e.g.
 * DeepAgents' TodoListMiddleware), these are first-class typed tool
 * contracts that flow through the policy engine, are traceable via
 * the audit layer, and persist in the agent's memory system.
 */

import { z } from 'zod';
import type { ToolContract, ToolResult } from '../types/tools';
import type { MemoryManager } from '../memory/MemoryManager';
import { tool } from './tool';

// ── Schemas ──

const TodoStatus = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
type TodoStatusType = z.infer<typeof TodoStatus>;

const WriteTodoInput = z.object({
  todos: z.array(
    z.object({
      id: z.string().optional().describe('ID for updating an existing todo. Omit to create.'),
      content: z.string().describe('Task description.'),
      status: TodoStatus.default('pending').describe('Task status.'),
    }),
  ).describe('List of todos to create or update.'),
});

const ListTodosInput = z.object({
  status: TodoStatus.optional().describe('Filter by status. Omit to list all.'),
});

// ── Types ──

export interface TodoEntry {
  id: string;
  content: string;
  status: TodoStatusType;
  createdAt: number;
  updatedAt: number;
}

export interface PlanningToolsOptions {
  /** Memory manager instance for persistence. */
  memory: MemoryManager;
}

// ── In-memory fallback (when no MemoryManager) ──

class InMemoryTodoStore {
  private todos = new Map<string, TodoEntry>();
  private nextId = 1;

  upsert(id: string | undefined, content: string, status: string): TodoEntry {
    const now = Date.now();
    if (id && this.todos.has(id)) {
      const existing = this.todos.get(id)!;
      existing.content = content;
      existing.status = status as TodoEntry['status'];
      existing.updatedAt = now;
      return existing;
    }
    const newId = id ?? `todo-${this.nextId++}`;
    const entry: TodoEntry = { id: newId, content, status: status as TodoEntry['status'], createdAt: now, updatedAt: now };
    this.todos.set(newId, entry);
    return entry;
  }

  list(status?: string): TodoEntry[] {
    const all = Array.from(this.todos.values());
    if (status) return all.filter((t) => t.status === status);
    return all;
  }
}

// ── Factory ──

/**
 * Create planning tools (`write_todo`, `list_todos`) that store tasks
 * in working memory.  If no `MemoryManager` is provided, an in-memory
 * fallback is used (tasks are lost when the process exits).
 *
 * @example
 * ```ts
 * const [writeTodo, listTodos] = createPlanningTools();
 * const agent = createAgent({
 *   tools: [writeTodo, listTodos, ...otherTools],
 *   // ...
 * });
 * ```
 */
export function createPlanningTools(
  options?: Partial<PlanningToolsOptions>,
): [ToolContract, ToolContract] {
  const store = new InMemoryTodoStore();
  const memory = options?.memory;

  const writeTodo = tool({
    name: 'write_todo',
    description:
      'Create or update a structured task list.  Use this to plan multi-step work, ' +
      'track progress, and mark tasks complete.  Always write todos before starting ' +
      'complex work so you can track what remains.',
    input: WriteTodoInput,
    safetyClass: 'write',
    async execute({ input }): Promise<ToolResult> {
      const results: TodoEntry[] = [];

      for (const item of input.todos) {
        const status: TodoStatusType = item.status ?? 'pending';

        if (memory) {
          const existing = item.id
            ? await memory.read(item.id)
            : null;

          if (existing) {
            await memory.delete(existing.id);
          }

          const entry = await memory.write({
            entry: {
              tier: 'working',
              kind: 'note',
              content: JSON.stringify({
                content: item.content,
                status,
                updatedAt: Date.now(),
              }),
              provenance: 'tool',
              confidence: 1,
              scope: 'run',
              ttlMs: 0,
              tags: ['todo', status],
            },
            overwriteStrategy: 'replace',
          });

          results.push({
            id: entry.id,
            content: item.content,
            status,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        } else {
          const entry = store.upsert(item.id, item.content, status);
          results.push(entry);
        }
      }

      const summary = results
        .map((t) => `- [${t.status}] ${t.id}: ${t.content}`)
        .join('\n');

      return {
        llmOutput: `Updated ${results.length} todo(s):\n${summary}`,
        success: true,
      };
    },
  });

  const listTodos = tool({
    name: 'list_todos',
    description: 'List current tasks, optionally filtered by status (pending, in_progress, completed, cancelled).',
    input: ListTodosInput,
    safetyClass: 'read',
    async execute({ input }): Promise<ToolResult> {
      let entries: TodoEntry[];

      if (memory) {
        const raw = await memory.getWorkingMemory();
        const todoEntries = raw.filter((e) => e.tags?.includes('todo'));
        entries = todoEntries.map((e) => {
          const parsed = JSON.parse(e.content);
          return {
            id: e.id,
            content: (parsed.content as string) ?? e.content,
            status: (parsed.status as TodoStatusType) ?? 'pending',
            createdAt: e.createdAt ?? Date.now(),
            updatedAt: (parsed.updatedAt as number) ?? Date.now(),
          };
        });

        if (input.status) {
          entries = entries.filter((e) => e.status === input.status);
        }
      } else {
        entries = store.list(input.status);
      }

      if (entries.length === 0) {
        return { llmOutput: 'No todos found.', success: true };
      }

      const summary = entries
        .map((t) => `- [${t.status}] ${t.id}: ${t.content}`)
        .join('\n');

      return {
        llmOutput: `${entries.length} todo(s):\n${summary}`,
        success: true,
      };
    },
  });

  return [writeTodo as ToolContract, listTodos as ToolContract];
}
