/**
 * @packageDocumentation
 * @module skills/skillify
 * @description
 * **Skillify** — the 10-step lifecycle for converting a real-world
 * failure trace into a durable, tested skill. This module exposes the
 * scaffolding logic as a pure function so it can be called from
 * tests, the CLI, or an agent (via `skill_manage`).
 *
 * The 10 steps (Hermes/Brain naming):
 *   1. SKILL.md — frontmatter + body capturing the rule
 *   2. Deterministic script — concrete implementation when applicable
 *   3. Unit test (vitest) for the script
 *   4. Integration test (sandbox) demonstrating end-to-end use
 *   5. Eval scenario (golden trace) gating regressions
 *   6. Resolver entry — ensure triggers route the failing intent here
 *   7. Resolver eval — confirm new skill wins resolution race
 *   8. DRY audit — check no overlap with existing skills
 *   9. Smoke run — short stateful test against a live model
 *  10. Brain-filing — checkpoint the failure trace + resolution
 */

import { hashSkillContent } from './parser';

export interface SkillifyInput {
  /** Stable id (snake_case). */
  id: string;
  /** One-sentence description. */
  description: string;
  /** Optional kind (default `'workflow'`). */
  kind?: string;
  /** Trigger phrases / keywords. At least one required. */
  triggers: Array<{ type: 'keyword' | 'phrase' | 'regex' | 'intent'; value?: string; pattern?: string; flags?: string }>;
  /** Author for provenance (e.g. agent id, user handle). */
  author?: string;
  /** Originating failure trace (free-text, embedded in body). */
  failureTrace?: string;
  /** Tags (default `[]`). */
  tags?: string[];
}

export interface SkillifyArtifact {
  /** Path relative to the skill root. */
  path: string;
  /** File contents. */
  contents: string;
  /** What the file represents — one of the 10 steps. */
  step: number;
  /** Human label for the step. */
  label: string;
}

export interface SkillifyResult {
  /** Skill id passed back for convenience. */
  id: string;
  /** Generated artifacts ready to be written to disk. */
  artifacts: SkillifyArtifact[];
  /** Checksum of the generated SKILL.md (sha256 first-16). */
  hash: string;
  /** Generated skill-pack root directory (relative). */
  rootDir: string;
}

const SAFE_ID = /^[a-z][a-z0-9_]*$/;

/** Scaffold a skill from a failure trace. Pure — does NOT write files. */
export function skillify(input: SkillifyInput): SkillifyResult {
  if (!SAFE_ID.test(input.id)) {
    throw new Error(
      `skillify: invalid id "${input.id}" — must be snake_case starting with a letter.`,
    );
  }
  if (!input.triggers || input.triggers.length === 0) {
    throw new Error('skillify: at least one trigger is required.');
  }

  const rootDir = `skills/${input.id}`;
  const kind = input.kind ?? 'workflow';
  const tags = input.tags ?? [];

  const skillMd = renderSkillMd({ ...input, kind, tags });
  const hash = hashSkillContent(skillMd);

  const artifacts: SkillifyArtifact[] = [
    {
      step: 1,
      label: 'SKILL.md',
      path: `${rootDir}/SKILL.md`,
      contents: skillMd,
    },
    {
      step: 2,
      label: 'deterministic script',
      path: `${rootDir}/script.ts`,
      contents: renderScript(input.id),
    },
    {
      step: 3,
      label: 'unit test',
      path: `${rootDir}/script.test.ts`,
      contents: renderUnitTest(input.id),
    },
    {
      step: 4,
      label: 'integration test',
      path: `${rootDir}/integration.test.ts`,
      contents: renderIntegrationTest(input.id),
    },
    {
      step: 5,
      label: 'eval scenario',
      path: `${rootDir}/eval.jsonl`,
      contents: renderEvalScenario(input),
    },
    {
      step: 6,
      label: 'resolver entry',
      path: `${rootDir}/resolver.ts`,
      contents: renderResolverEntry(input.id),
    },
    {
      step: 7,
      label: 'resolver eval',
      path: `${rootDir}/resolver.eval.test.ts`,
      contents: renderResolverEvalTest(input),
    },
    {
      step: 8,
      label: 'DRY audit notes',
      path: `${rootDir}/DRY.md`,
      contents: renderDryNotes(input.id),
    },
    {
      step: 9,
      label: 'smoke runner',
      path: `${rootDir}/smoke.ts`,
      contents: renderSmokeRunner(input.id),
    },
    {
      step: 10,
      label: 'brain-filing record',
      path: `${rootDir}/BRAIN.md`,
      contents: renderBrainFile(input),
    },
  ];

  return { id: input.id, artifacts, hash, rootDir };
}

// ── Renderers ──────────────────────────────────────────────────────────────

function renderSkillMd(input: Required<Pick<SkillifyInput, 'kind' | 'tags'>> & SkillifyInput): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${input.id}`);
  lines.push(`name: ${input.id}`);
  lines.push(`description: ${quote(input.description)}`);
  lines.push(`kind: ${input.kind}`);
  if (input.tags.length) {
    lines.push('tags:');
    for (const t of input.tags) lines.push(`  - ${t}`);
  }
  lines.push('triggers:');
  for (const t of input.triggers) {
    if (t.type === 'regex') {
      lines.push(`  - type: regex`);
      lines.push(`    pattern: ${quote(t.pattern ?? '')}`);
      if (t.flags) lines.push(`    flags: ${quote(t.flags)}`);
    } else {
      lines.push(`  - type: ${t.type}`);
      lines.push(`    value: ${quote(t.value ?? '')}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(`# ${input.id}`);
  lines.push('');
  lines.push(input.description);
  lines.push('');
  if (input.failureTrace) {
    lines.push('## Origin');
    lines.push('');
    lines.push('This skill was distilled from the following failure trace:');
    lines.push('');
    lines.push('```');
    lines.push(input.failureTrace.trim());
    lines.push('```');
    lines.push('');
  }
  lines.push('## Procedure');
  lines.push('');
  lines.push('1. Recognise the intent via the triggers above.');
  lines.push('2. Apply the deterministic script in `script.ts` when applicable.');
  lines.push('3. Validate with the unit + integration tests before relying on this skill in production.');
  lines.push('');
  lines.push('## Anti-patterns');
  lines.push('');
  lines.push('- Do not invoke this skill outside of the trigger contexts; review SKILL.md first.');
  lines.push('');
  return lines.join('\n');
}

function quote(s: string): string {
  // Single-quote if it contains anything special.
  if (/[:#"'[\]{},&*!|>%@`]/.test(s) || /^\s|\s$/.test(s)) {
    return `'${s.replace(/'/g, "''")}'`;
  }
  return s;
}

function renderScript(id: string): string {
  return `/**
 * Deterministic script for skill "${id}".
 *
 * Replace this stub with a pure function that captures the rule.
 * Keep it small, side-effect-free, and unit-testable.
 */
export interface ${pascal(id)}Input {
  // TODO: define inputs
}

export interface ${pascal(id)}Output {
  success: boolean;
  message: string;
}

export async function run${pascal(id)}(_input: ${pascal(id)}Input): Promise<${pascal(id)}Output> {
  return { success: false, message: 'skill "${id}" not yet implemented' };
}
`;
}

function renderUnitTest(id: string): string {
  return `import { describe, it, expect } from 'vitest';
import { run${pascal(id)} } from './script';

describe('${id} (unit)', () => {
  it('returns a structured result', async () => {
    const out = await run${pascal(id)}({} as any);
    expect(out).toMatchObject({ success: expect.any(Boolean), message: expect.any(String) });
  });
});
`;
}

function renderIntegrationTest(id: string): string {
  return `import { describe, it, expect } from 'vitest';
// import the agent runtime and assert the skill fires in a real scenario.

describe.skip('${id} (integration)', () => {
  it('drives the agent loop end-to-end', async () => {
    expect(true).toBe(true);
  });
});
`;
}

function renderEvalScenario(input: SkillifyInput): string {
  const probe = pickProbe(input.triggers);
  return JSON.stringify(
    {
      id: `${input.id}.golden`,
      intent: probe,
      expect: { topSkill: input.id, minScore: 0.4 },
    },
    null,
    0,
  );
}

function renderResolverEntry(id: string): string {
  return `/** Registry entry for "${id}". Import + register at runtime startup. */
export const ${camel(id)}Entry = { id: '${id}', path: './SKILL.md' };
`;
}

function renderResolverEvalTest(input: SkillifyInput): string {
  const probe = pickProbe(input.triggers);
  return `import { describe, it, expect } from 'vitest';
import { SkillRegistry, SkillResolver, parseSkillDocument } from '@veridex/agents';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('${input.id} (resolver eval)', () => {
  it('wins resolution for its golden probe', () => {
    const content = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
    const skill = parseSkillDocument(content);
    const reg = new SkillRegistry();
    reg.register(skill);
    const r = new SkillResolver(reg);
    const matches = r.resolve(${JSON.stringify(probe)});
    expect(matches[0]?.skill.id).toBe('${input.id}');
  });
});
`;
}

function renderDryNotes(id: string): string {
  return `# DRY audit — ${id}

Run \`veridex skill dry-audit\` periodically; record overlap findings here.

- [ ] No identical trigger registered elsewhere.
- [ ] Body distinct from related skills.
- [ ] Tags do not duplicate adjacent skills' tags.
`;
}

function renderSmokeRunner(id: string): string {
  return `/**
 * Smoke runner for "${id}". Run against a live (or replay) model to confirm
 * the skill actually changes agent behaviour, not just the resolver.
 */
export async function smoke${pascal(id)}() {
  console.log('TODO: drive the agent against the skill\\'s golden intent and assert tool calls / outputs.');
}
`;
}

function renderBrainFile(input: SkillifyInput): string {
  return `# Brain file — ${input.id}

- **Created**: ${new Date().toISOString()}
${input.author ? `- **Author**: ${input.author}\n` : ''}- **Description**: ${input.description}
${input.failureTrace ? `\n## Originating failure\n\n\`\`\`\n${input.failureTrace.trim()}\n\`\`\`\n` : ''}
## Resolution

Triggers + deterministic script + tests now guard against the original failure. Update this file when the skill evolves.
`;
}

function pickProbe(
  triggers: SkillifyInput['triggers'],
): string {
  for (const t of triggers) {
    if (t.type === 'phrase' && t.value) return t.value;
  }
  for (const t of triggers) {
    if (t.type === 'keyword' && t.value) return t.value;
  }
  for (const t of triggers) {
    if (t.type === 'regex' && t.pattern) {
      // Strip metas — naive but deterministic.
      const cleaned = t.pattern.replace(/[\\^$*+?{}()|[\].]/g, ' ').trim();
      const first = cleaned.split(/\s+/).find((s) => s.length >= 3);
      if (first) return first;
    }
  }
  return 'invoke skill';
}

function pascal(s: string): string {
  return s.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());
}

function camel(s: string): string {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
}
