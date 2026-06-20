/**
 * @packageDocumentation
 * @module skills/audit
 * @description
 * Skill-quality audits:
 *
 *   1. `check-resolvable`: every registered skill MUST be reachable by
 *      at least one trigger (keyword/phrase/regex/intent). Skills with
 *      no triggers, or with triggers that overlap so weakly that they
 *      lose every resolution race, are reported.
 *
 *   2. `DRY audit`: detect overlapping skills — same triggers, near-
 *      duplicate descriptions, identical bodies. Overlap silently
 *      degrades resolver precision; this surfaces it as a CI gate.
 */

import { SkillResolver } from './SkillResolver';
import type { SkillResolverOptions } from './SkillResolver';
import type { SkillRegistry } from './SkillRegistry';
import type { SkillContract, SkillTrigger } from './types';

// ── check-resolvable ───────────────────────────────────────────────────────

export type ResolvableIssueKind =
  | 'no_triggers'
  | 'invalid_regex'
  | 'unresolvable_by_own_triggers'
  | 'shadowed_by_another_skill';

export interface ResolvableIssue {
  skillId: string;
  kind: ResolvableIssueKind;
  message: string;
  /** When `shadowed_by_another_skill`, the id that consistently outranks this. */
  rival?: string;
}

export interface CheckResolvableOptions extends SkillResolverOptions {
  /**
   * Synthetic probes — strings the resolver runs against each skill's
   * triggers to confirm the skill wins its own slot. Defaults are
   * derived from each skill's trigger values.
   */
  probes?: Record<string, string[]>;
}

/**
 * For each skill, verify that the skill itself is resolved as the top
 * match for at least one probe derived from its triggers.
 */
export function checkResolvable(
  registry: SkillRegistry,
  options: CheckResolvableOptions = {},
): ResolvableIssue[] {
  const resolver = new SkillResolver(registry, options);
  const issues: ResolvableIssue[] = [];

  for (const skill of registry.values()) {
    const triggers = skill.frontmatter.triggers ?? [];
    if (triggers.length === 0) {
      issues.push({
        skillId: skill.id,
        kind: 'no_triggers',
        message: `Skill "${skill.id}" has no triggers — it can never be resolved by the SkillResolver.`,
      });
      continue;
    }

    // Validate regexes — surfaces typos early.
    for (const t of triggers) {
      if (t.type === 'regex') {
        try {
          new RegExp(t.pattern, t.flags ?? 'i');
        } catch (e) {
          issues.push({
            skillId: skill.id,
            kind: 'invalid_regex',
            message: `Skill "${skill.id}" has an invalid regex trigger /${t.pattern}/${t.flags ?? ''}: ${(e as Error).message}`,
          });
        }
      }
    }

    const probes =
      options.probes?.[skill.id] ?? deriveProbes(skill, registry);
    if (probes.length === 0) {
      issues.push({
        skillId: skill.id,
        kind: 'unresolvable_by_own_triggers',
        message: `Skill "${skill.id}" has triggers but no synthetic probe could be derived from them (intent-only triggers without classifiers).`,
      });
      continue;
    }

    let resolvedAtLeastOnce = false;
    let lastRival: string | undefined;
    for (const probe of probes) {
      const matches = resolver.resolve(probe);
      const top = matches[0];
      if (!top) continue;
      if (top.skill.id === skill.id) {
        resolvedAtLeastOnce = true;
        break;
      }
      lastRival = top.skill.id;
    }

    if (!resolvedAtLeastOnce) {
      if (lastRival) {
        issues.push({
          skillId: skill.id,
          kind: 'shadowed_by_another_skill',
          message: `Skill "${skill.id}" is shadowed by "${lastRival}" on every synthetic probe derived from its triggers.`,
          rival: lastRival,
        });
      } else {
        issues.push({
          skillId: skill.id,
          kind: 'unresolvable_by_own_triggers',
          message: `Skill "${skill.id}" cannot resolve itself from its own triggers — the resolver returned zero matches for every probe.`,
        });
      }
    }
  }
  return issues;
}

function deriveProbes(skill: SkillContract, _registry: SkillRegistry): string[] {
  const probes = new Set<string>();
  for (const t of skill.frontmatter.triggers ?? []) {
    if (t.type === 'keyword' || t.type === 'phrase') {
      probes.add(t.value);
    } else if (t.type === 'regex') {
      // Best-effort: extract literal segments from the pattern.
      const literal = extractRegexLiteral(t.pattern);
      if (literal) probes.add(literal);
    }
    // 'intent' triggers require user-supplied classifiers — we can't
    // generate probes for them.
  }
  return [...probes];
}

function extractRegexLiteral(pattern: string): string | null {
  // Strip anchors + simple meta; keep only [a-zA-Z0-9 _-] runs.
  const cleaned = pattern.replace(/[\\^$*+?{}()|[\].]/g, ' ').trim();
  const runs = cleaned.split(/\s+/).filter((r) => r.length >= 3);
  return runs.length ? runs[0] : null;
}

// ── DRY audit ──────────────────────────────────────────────────────────────

export type DryIssueKind =
  | 'duplicate_id_across_packs'
  | 'identical_body'
  | 'duplicate_trigger'
  | 'overlapping_keywords';

export interface DryIssue {
  kind: DryIssueKind;
  message: string;
  /** Skill ids involved (always ≥2). */
  skillIds: string[];
}

export interface DryAuditOptions {
  /** Jaccard threshold (0..1) over keyword/phrase trigger sets above which
   *  two skills are considered overlapping. Default 0.6. */
  keywordOverlapThreshold?: number;
}

/** Detect duplicate / overlapping skills across the registry. */
export function dryAudit(
  registry: SkillRegistry,
  options: DryAuditOptions = {},
): DryIssue[] {
  const issues: DryIssue[] = [];
  const skills = registry.values();
  const threshold = options.keywordOverlapThreshold ?? 0.6;

  // 1. Same body hash from different sources.
  const byBodyHash = new Map<string, string[]>();
  for (const s of skills) {
    const key = `${s.body.trim().length}:${cheapHash(s.body)}`;
    const bucket = byBodyHash.get(key) ?? [];
    bucket.push(s.id);
    byBodyHash.set(key, bucket);
  }
  for (const [, ids] of byBodyHash) {
    if (ids.length > 1) {
      issues.push({
        kind: 'identical_body',
        message: `Skills ${ids.map((i) => `"${i}"`).join(', ')} share an identical body — consolidate or differentiate.`,
        skillIds: ids,
      });
    }
  }

  // 2. Identical trigger across skills (keyword/phrase/regex pattern).
  const byTriggerKey = new Map<string, string[]>();
  for (const s of skills) {
    for (const t of s.frontmatter.triggers ?? []) {
      const key = triggerKey(t);
      if (!key) continue;
      const bucket = byTriggerKey.get(key) ?? [];
      bucket.push(s.id);
      byTriggerKey.set(key, bucket);
    }
  }
  for (const [key, ids] of byTriggerKey) {
    const uniq = [...new Set(ids)];
    if (uniq.length > 1) {
      issues.push({
        kind: 'duplicate_trigger',
        message: `Trigger ${key} is registered by skills ${uniq.map((i) => `"${i}"`).join(', ')} — only the highest-scoring one will ever win.`,
        skillIds: uniq,
      });
    }
  }

  // 3. Pairwise keyword/phrase set overlap above threshold.
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i];
      const b = skills[j];
      const overlap = jaccardTriggerOverlap(a, b);
      if (overlap >= threshold) {
        issues.push({
          kind: 'overlapping_keywords',
          message: `Skills "${a.id}" and "${b.id}" share a high trigger Jaccard (${overlap.toFixed(2)}) — resolver precision will suffer.`,
          skillIds: [a.id, b.id],
        });
      }
    }
  }

  return issues;
}

function triggerKey(t: SkillTrigger): string | null {
  switch (t.type) {
    case 'keyword':
      return `kw:${t.value.toLowerCase()}`;
    case 'phrase':
      return `ph:${t.value.toLowerCase()}`;
    case 'regex':
      return `re:/${t.pattern}/${t.flags ?? ''}`;
    case 'intent':
      return `in:${t.value}`;
  }
}

function jaccardTriggerOverlap(a: SkillContract, b: SkillContract): number {
  const sa = new Set(
    (a.frontmatter.triggers ?? [])
      .filter((t) => t.type === 'keyword' || t.type === 'phrase')
      .map((t) => (t as { value: string }).value.toLowerCase()),
  );
  const sb = new Set(
    (b.frontmatter.triggers ?? [])
      .filter((t) => t.type === 'keyword' || t.type === 'phrase')
      .map((t) => (t as { value: string }).value.toLowerCase()),
  );
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const v of sa) if (sb.has(v)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function cheapHash(s: string): string {
  // FNV-1a 32-bit — sufficient for body-equality bucketing.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
