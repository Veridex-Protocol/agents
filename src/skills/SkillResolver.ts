/**
 * @packageDocumentation
 * @module skills/SkillResolver
 * @description
 * Map an intent (user message / tool-call hint) to a ranked set of
 * candidate skills. The resolver is intentionally pluggable: the
 * default strategy is rule-based (keyword/phrase/regex/intent), and
 * a custom strategy can be supplied via `customStrategies`.
 *
 * **Design**:
 *   - Triggers are normalised once at registration time (regex
 *     compilation cached) so resolve() is O(skills * triggers).
 *   - Intent classifiers are user-supplied (`intentClassifiers`)
 *     because they typically require domain knowledge.
 *   - Scores sum across triggers, capped at 1.0.
 */

import type { SkillRegistry } from './SkillRegistry';
import { frontmatterToSummary } from './SkillRegistry';
import type {
  SkillContract,
  SkillMatch,
  SkillSummary,
  SkillTrigger,
} from './types';

/** Strategy: receives an intent + skill, returns a match score in [0,1] or 0. */
export type ResolverStrategy = (
  intent: string,
  skill: SkillContract,
  ctx: ResolverContext,
) => { score: number; reasons: string[]; matched: SkillTrigger[] } | null;

export interface ResolverContext {
  /** Lowercased intent text. */
  intentLower: string;
  /** Tokens (split on whitespace + punctuation). */
  tokens: string[];
}

export interface SkillResolverOptions {
  /**
   * Map from intent name → classifier. Each classifier returns a score
   * in [0,1] indicating how confident it is that the intent is "this".
   *
   * Used for `{ type: 'intent', value: '<intent-name>' }` triggers.
   */
  intentClassifiers?: Record<string, (intent: string) => number>;
  /** Custom strategies appended after the default rule-based one. */
  customStrategies?: ResolverStrategy[];
  /** Minimum match score to surface (default 0.05). */
  minScore?: number;
  /** Max matches returned by `resolve()` (default 5). */
  maxResults?: number;
  /**
   * Per-trigger weights (defaults: keyword 0.25, phrase 0.5, regex 0.6, intent 0.8).
   * Multiple matches stack, capped at 1.0.
   */
  triggerWeights?: Partial<Record<SkillTrigger['type'], number>>;
}

const DEFAULT_WEIGHTS: Record<SkillTrigger['type'], number> = {
  keyword: 0.25,
  phrase: 0.5,
  regex: 0.6,
  intent: 0.8,
};

export class SkillResolver {
  private readonly registry: SkillRegistry;
  private readonly options: Required<
    Omit<SkillResolverOptions, 'intentClassifiers' | 'customStrategies' | 'triggerWeights'>
  > & {
    intentClassifiers: Record<string, (intent: string) => number>;
    customStrategies: ResolverStrategy[];
    triggerWeights: Record<SkillTrigger['type'], number>;
  };

  /** Cached compiled regex per trigger (keyed by `pattern\u0000flags`). */
  private readonly regexCache = new Map<string, RegExp>();

  constructor(registry: SkillRegistry, options: SkillResolverOptions = {}) {
    this.registry = registry;
    this.options = {
      minScore: options.minScore ?? 0.05,
      maxResults: options.maxResults ?? 5,
      intentClassifiers: options.intentClassifiers ?? {},
      customStrategies: options.customStrategies ?? [],
      triggerWeights: { ...DEFAULT_WEIGHTS, ...(options.triggerWeights ?? {}) },
    };
  }

  /** Resolve an intent to a ranked list of candidate skills. */
  resolve(intent: string): SkillMatch[] {
    const intentLower = intent.toLowerCase();
    const tokens = tokenize(intentLower);
    const ctx: ResolverContext = { intentLower, tokens };

    const matches: SkillMatch[] = [];
    for (const skill of this.registry.values()) {
      const summary = frontmatterToSummary(skill.frontmatter);
      const result = this.scoreSkill(intent, skill, ctx);
      if (result.score >= this.options.minScore) {
        matches.push({
          skill: summary,
          score: Math.min(1, result.score),
          matchedTriggers: result.matched,
          reasons: result.reasons,
        });
      }
    }
    matches.sort(
      (a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id),
    );
    return matches.slice(0, this.options.maxResults);
  }

  /** Internal: score a single skill against the intent. */
  private scoreSkill(
    intent: string,
    skill: SkillContract,
    ctx: ResolverContext,
  ): { score: number; reasons: string[]; matched: SkillTrigger[] } {
    let score = 0;
    const reasons: string[] = [];
    const matched: SkillTrigger[] = [];

    const triggers = skill.frontmatter.triggers ?? [];
    for (const trig of triggers) {
      const w = this.options.triggerWeights[trig.type];
      const fired = this.evalTrigger(trig, intent, ctx);
      if (fired === null) continue;
      score += w * fired;
      reasons.push(triggerReason(trig, fired));
      matched.push(trig);
    }

    for (const strat of this.options.customStrategies) {
      const r = strat(intent, skill, ctx);
      if (r && r.score > 0) {
        score += r.score;
        reasons.push(...r.reasons);
        matched.push(...r.matched);
      }
    }

    return { score, reasons, matched };
  }

  /**
   * Evaluate a single trigger. Returns a score in [0,1] or null if no match.
   * `score` differentiates strong vs partial matches (e.g. multi-keyword).
   */
  private evalTrigger(
    trig: SkillTrigger,
    intent: string,
    ctx: ResolverContext,
  ): number | null {
    switch (trig.type) {
      case 'keyword': {
        const v = trig.value.toLowerCase();
        if (!v) return null;
        return ctx.intentLower.includes(v) ? 1 : null;
      }
      case 'phrase': {
        const v = trig.value.toLowerCase().trim();
        if (!v) return null;
        // Word-boundary aware match.
        const re = wordBoundaryRegex(v);
        return re.test(ctx.intentLower) ? 1 : null;
      }
      case 'regex': {
        const key = `${trig.pattern}\u0000${trig.flags ?? ''}`;
        let re = this.regexCache.get(key);
        if (!re) {
          try {
            re = new RegExp(trig.pattern, trig.flags ?? 'i');
            this.regexCache.set(key, re);
          } catch {
            return null; // bad regex → ignore
          }
        }
        return re.test(intent) ? 1 : null;
      }
      case 'intent': {
        const classifier = this.options.intentClassifiers[trig.value];
        if (!classifier) return null;
        const s = classifier(intent);
        if (!Number.isFinite(s) || s <= 0) return null;
        return Math.max(0, Math.min(1, s));
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const TOKEN_RE = /[a-z0-9_]+/g;
function tokenize(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}

function wordBoundaryRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, 'i');
}

function triggerReason(t: SkillTrigger, score: number): string {
  switch (t.type) {
    case 'keyword':
      return `keyword:${t.value}`;
    case 'phrase':
      return `phrase:${t.value}`;
    case 'regex':
      return `regex:/${t.pattern}/${t.flags ?? ''}`;
    case 'intent':
      return `intent:${t.value}(${score.toFixed(2)})`;
  }
}

export type { SkillSummary };
