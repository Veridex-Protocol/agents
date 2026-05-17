/**
 * MemoryTools — Phase 3.3 (memory-as-tool)
 *
 * Built-in tools that let an agent self-edit its long-term memory, modelled
 * after Letta's `memory_insert`/`memory_replace`/`memory_archive` triad.
 * Every operation goes through the registered `ToolPolicyEngine` /
 * `ApprovalManager` like any other tool, so writes can be inspected,
 * audited, and denied by policy.
 *
 * The tools are deliberately thin wrappers over `MutableMemoryStore` so
 * the same set works for any backend that opts into the mutation
 * interface.
 */

import { z } from 'zod';
import type { ToolContract } from '../types/tools';
import { tool } from '../tools/tool';
import type { MutableMemoryStore } from '../memory/MemoryLifecycle';
import type { MemoryTier, MemoryScope, MemoryProvenance } from '../types/memory';

const tierEnum: [MemoryTier, ...MemoryTier[]] = [
  'working',
  'episodic',
  'semantic',
  'procedural',
];
const scopeEnum: [MemoryScope, ...MemoryScope[]] = ['turn', 'run', 'agent', 'global'];

const insertInput = z.object({
  tier: z.enum(tierEnum).optional(),
  content: z.string().min(1, 'content is required'),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  scope: z.enum(scopeEnum).optional(),
  ttlMs: z.number().int().nonnegative().optional(),
});

const replaceInput = z.object({
  id: z.string().min(1),
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const archiveInput = z.object({
  id: z.string().min(1),
  reason: z.string().max(280).optional(),
});

export interface CreateMemoryToolsOptions {
  store: MutableMemoryStore;
  /** Provenance recorded on entries created by `memory_insert`. */
  provenance?: MemoryProvenance;
}

/**
 * Returns the three built-in memory tools wired to the supplied store.
 * Register them with `AgentRuntime` like any other tool.
 */
export function createMemoryTools(opts: CreateMemoryToolsOptions): ToolContract[] {
  const { store } = opts;
  const provenance: MemoryProvenance = opts.provenance ?? 'agent';

  const insert = tool({
    name: 'memory_insert',
    description:
      'Insert a new entry into the agent\'s long-term memory store. Use this to record durable facts, decisions, user preferences, or task state that should survive across turns.',
    guidance: {
      summary: 'Persist a new memory entry the agent can recall later.',
      whenToUse: [
        'You learn a durable fact the user expects you to remember (preferences, workspace facts, decisions, evidence).',
      ],
      whenNotToUse: [
        'For transient scratch notes within a single turn — working memory handles those implicitly.',
      ],
    },
    input: insertInput,
    safetyClass: 'write',
    idempotent: false,
    async execute({ input }) {
      const entry = await store.write({
        overwriteStrategy: 'skip',
        entry: {
          tier: input.tier ?? 'semantic',
          content: input.content,
          provenance,
          confidence: input.confidence ?? 0.7,
          scope: input.scope ?? 'agent',
          ttlMs: input.ttlMs ?? 0,
          tags: input.tags ?? [],
        },
      });
      return {
        success: true,
        llmOutput: `inserted memory ${entry.id} (tier=${entry.tier}, confidence=${entry.confidence.toFixed(2)})`,
        data: { id: entry.id, tier: entry.tier },
      };
    },
  });

  const replace = tool({
    name: 'memory_replace',
    description:
      'Update an existing memory entry by id. Use to correct outdated facts, adjust confidence, or add tags. The id is preserved.',
    guidance: {
      summary: 'Edit an existing memory entry in place.',
      whenToUse: [
        'A stored fact is wrong or needs refinement and you have its id from a prior retrieval.',
      ],
      whenNotToUse: [
        'The change is so large that the meaning shifts entirely — prefer inserting a new entry and archiving the old one.',
      ],
    },
    input: replaceInput,
    safetyClass: 'write',
    idempotent: true,
    async execute({ input }) {
      const updated = await store.update(input.id, {
        content: input.content,
        tags: input.tags,
        confidence: input.confidence,
      });
      if (!updated) {
        return {
          success: false,
          llmOutput: `No memory entry found with id "${input.id}".`,
          error: 'memory_not_found',
        };
      }
      return {
        success: true,
        llmOutput: `updated memory ${updated.id}`,
        data: { id: updated.id },
      };
    },
  });

  const archive = tool({
    name: 'memory_archive',
    description:
      'Soft-archive a memory entry: it stays in the store but is tagged "archived", dropped to low confidence, and de-prioritised in future retrievals.',
    guidance: {
      summary: 'Retire a memory entry without losing the historical record.',
      whenToUse: [
        'An entry is superseded but you may still want it for audit or to derive a successor entry.',
      ],
      whenNotToUse: [
        'You simply need to correct a value — use `memory_replace` instead.',
      ],
    },
    input: archiveInput,
    safetyClass: 'write',
    idempotent: true,
    async execute({ input }) {
      const existing = await store.read(input.id);
      if (!existing) {
        return {
          success: false,
          llmOutput: `No memory entry found with id "${input.id}".`,
          error: 'memory_not_found',
        };
      }
      const nextTags = Array.from(new Set<string>([...existing.tags, 'archived']));
      await store.update(input.id, {
        tags: nextTags,
        confidence: Math.min(existing.confidence, 0.1),
      });
      return {
        success: true,
        llmOutput: `archived memory ${input.id}${input.reason ? ` (${input.reason})` : ''}`,
        data: { id: input.id },
      };
    },
  });

  return [insert as unknown as ToolContract, replace as unknown as ToolContract, archive as unknown as ToolContract];
}
