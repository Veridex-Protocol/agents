/**
 * @packageDocumentation
 * @module skills/SkillTools
 * @description
 * Built-in tools that expose skills to the agent at runtime:
 *
 *   - `load_skill` — fetch a skill's full body on demand (progressive
 *     disclosure analog to `load_tool`).
 *   - `find_skills` — search registered skills by intent. Returns the
 *     ranked match list from {@link SkillResolver}.
 *   - `skill_manage` — agent self-authors a new skill via skillify().
 *     Gated: emits a {@link SkillProposal} that the runtime can
 *     route through the policy + approval pipeline.
 */

import { z } from 'zod';
import { tool } from '../tools/tool';
import type { ToolContract } from '../types/tools';
import type { SkillRegistry } from './SkillRegistry';
import { renderSkillDetail } from './SkillRegistry';
import type { SkillResolver } from './SkillResolver';
import { skillify, type SkillifyInput, type SkillifyResult } from './skillify';
import { parseSkillDocument } from './parser';

/**
 * Proposal emitted when the agent invokes `skill_manage` with mode
 * `'author'`. The runtime should route this through the policy engine
 * and (when required) the approval manager before persisting.
 */
export interface SkillProposal {
  type: 'skill_write';
  /** Stable id for tracing. */
  id: string;
  /** Input that produced the proposal. */
  input: SkillifyInput;
  /** Pre-generated artifacts (writeable on approval). */
  result: SkillifyResult;
  /** Provenance — usually the agent id / run id. */
  proposedBy?: string;
}

/** Callback the runtime registers to handle approved proposals. */
export type SkillProposalHandler = (
  proposal: SkillProposal,
) => Promise<{ approved: boolean; reason?: string }>;

// ── load_skill ─────────────────────────────────────────────────────────────

export function createLoadSkillBuiltin(registry: SkillRegistry): ToolContract {
  return tool({
    name: 'load_skill',
    guidance: {
      summary:
        'Fetch the full body of a registered skill, including procedure steps and bundled scripts.',
      whenToUse: [
        'Before applying a skill whose body is not yet in context.',
        'When a skill id appears in resolver output but the body has not been disclosed.',
      ],
      whenNotToUse: [
        'When the skill has already been loaded in a previous turn.',
        'When the user intent is unrelated to any registered skill.',
      ],
      successExample:
        'Returns the markdown body with procedure, anti-patterns, and bundled-script references.',
    },
    input: z.object({
      id: z.string().min(1).describe('Exact skill id from the disclosed catalog.'),
    }),
    safetyClass: 'read',
    idempotent: true,
    async execute({ input }) {
      const skill = registry.load(input.id);
      if (!skill) {
        return {
          success: false,
          llmOutput: `No skill named "${input.id}" is registered. Refer to the disclosed skill catalog for available ids.`,
          error: 'skill_not_found',
        };
      }
      return {
        success: true,
        llmOutput: renderSkillDetail(skill),
      };
    },
  }) as unknown as ToolContract;
}

// ── find_skills ────────────────────────────────────────────────────────────

export function createFindSkillsBuiltin(
  resolver: SkillResolver,
): ToolContract {
  return tool({
    name: 'find_skills',
    guidance: {
      summary:
        'Search registered skills by intent — returns a ranked list of candidate skills with match scores.',
      whenToUse: [
        'When unsure which skill applies to the current user intent.',
        'Before authoring a new skill — to verify one does not already exist (DRY).',
      ],
      whenNotToUse: [
        'When a specific skill id is already known — call `load_skill` directly.',
      ],
      successExample:
        'Returns up to 5 matches with score, matched triggers, and one-line descriptions.',
    },
    input: z.object({
      intent: z.string().min(1).describe('Natural-language intent or query.'),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    safetyClass: 'read',
    idempotent: true,
    async execute({ input }) {
      const matches = resolver.resolve(input.intent);
      const limited = matches.slice(0, input.limit ?? 5);
      if (limited.length === 0) {
        return {
          success: true,
          llmOutput:
            'No registered skill matched that intent. Consider authoring one with `skill_manage` (mode: "author").',
        };
      }
      const lines = limited.map(
        (m) =>
          `- ${m.skill.id} (score=${m.score.toFixed(2)}) — ${m.skill.description}\n    matched: ${m.reasons.join(', ')}`,
      );
      return { success: true, llmOutput: lines.join('\n') };
    },
  }) as unknown as ToolContract;
}

// ── skill_manage ───────────────────────────────────────────────────────────

export interface SkillManageOptions {
  /** Registry to operate against. */
  registry: SkillRegistry;
  /** Resolver — used for `mode: 'find'`. */
  resolver: SkillResolver;
  /**
   * Handler invoked when the agent proposes a NEW skill. The handler
   * decides (via policy / approval) whether to persist it. When the
   * handler returns `{approved: true}`, the runtime should call
   * `registry.register(parseSkillDocument(result.artifacts[0].contents))`
   * itself — `skill_manage` is intentionally *write-deferred*.
   */
  onProposal?: SkillProposalHandler;
  /** Agent id used as `proposedBy` on proposals. */
  proposedBy?: string;
}

const skillManageInput = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('find'),
    intent: z.string().min(1),
  }),
  z.object({
    mode: z.literal('describe'),
    id: z.string().min(1),
  }),
  z.object({
    mode: z.literal('author'),
    id: z.string().min(1),
    description: z.string().min(1),
    kind: z.string().optional(),
    tags: z.array(z.string()).optional(),
    triggers: z
      .array(
        z.object({
          type: z.enum(['keyword', 'phrase', 'regex', 'intent']),
          value: z.string().optional(),
          pattern: z.string().optional(),
          flags: z.string().optional(),
        }),
      )
      .min(1),
    failureTrace: z.string().optional(),
  }),
]);

export function createSkillManageBuiltin(
  options: SkillManageOptions,
): ToolContract {
  const { registry, resolver, onProposal, proposedBy } = options;

  return tool({
    name: 'skill_manage',
    guidance: {
      summary:
        'Find, describe, or author skills. Authoring emits a gated proposal — it does not write to disk directly.',
      whenToUse: [
        'When the agent needs to introspect its own skill catalog.',
        'When a recurring failure suggests a new skill should be authored.',
      ],
      whenNotToUse: [
        'For one-off requests that do not need persistence.',
        'When a similar skill already exists — call `find_skills` first.',
      ],
      successExample:
        'For `author` mode: returns a `proposalId` and `approved: true|false` after the runtime policy/approval pipeline runs.',
    },
    input: skillManageInput as unknown as z.ZodType<z.infer<typeof skillManageInput>>,
    safetyClass: 'privileged',
    idempotent: false,
    async execute({ input }) {
      if (input.mode === 'find') {
        const matches = resolver.resolve(input.intent);
        return {
          success: true,
          llmOutput:
            matches.length === 0
              ? 'No matching skills.'
              : matches
                  .map((m) => `${m.skill.id} (${m.score.toFixed(2)}) — ${m.skill.description}`)
                  .join('\n'),
        };
      }

      if (input.mode === 'describe') {
        const skill = registry.load(input.id);
        if (!skill) {
          return {
            success: false,
            llmOutput: `No skill "${input.id}".`,
            error: 'skill_not_found',
          };
        }
        return { success: true, llmOutput: renderSkillDetail(skill) };
      }

      // mode === 'author'
      let result: SkillifyResult;
      try {
        result = skillify({
          id: input.id,
          description: input.description,
          kind: input.kind,
          tags: input.tags,
          triggers: input.triggers,
          failureTrace: input.failureTrace,
          author: proposedBy,
        });
      } catch (e) {
        return {
          success: false,
          llmOutput: `skillify failed: ${(e as Error).message}`,
          error: 'invalid_skill_input',
        };
      }

      const proposal: SkillProposal = {
        type: 'skill_write',
        id: input.id,
        input: {
          id: input.id,
          description: input.description,
          kind: input.kind,
          tags: input.tags,
          triggers: input.triggers,
          failureTrace: input.failureTrace,
          author: proposedBy,
        },
        result,
        proposedBy,
      };

      if (!onProposal) {
        return {
          success: false,
          llmOutput:
            'skill_manage(author) requires an approval handler — none is registered on the runtime. Proposal was discarded.',
          error: 'no_approval_handler',
        };
      }

      const decision = await onProposal(proposal);
      if (!decision.approved) {
        return {
          success: false,
          llmOutput: `Skill proposal "${input.id}" was rejected${decision.reason ? `: ${decision.reason}` : '.'}`,
          error: 'proposal_rejected',
        };
      }

      // The handler approved — register an in-memory copy so the
      // resolver / catalog reflect the new skill immediately. Persisting
      // to disk is the handler's responsibility.
      try {
        const skillMd = result.artifacts.find((a) => a.path.endsWith('SKILL.md'));
        if (skillMd) {
          const parsed = parseSkillDocument(skillMd.contents, {
            source: { kind: 'agent_authored' },
          });
          registry.replace(parsed);
        }
      } catch {
        // Registration is best-effort — handler still considered the
        // authority.
      }

      return {
        success: true,
        llmOutput: `Skill "${input.id}" authored. Hash: ${result.hash}. Resolver updated in-memory.`,
      };
    },
  }) as unknown as ToolContract;
}
