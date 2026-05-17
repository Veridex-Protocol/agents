/**
 * @packageDocumentation
 * @module skills/types
 * @description
 * First-class Skill primitive for Veridex (Phase 4).
 *
 * A **Skill** is a portable, lazily-loaded unit of agent know-how: a
 * markdown body that teaches an agent how to handle a class of intents,
 * optionally bundled with deterministic scripts, tool contracts, and
 * tests. Skills are progressive-disclosure by default — only the
 * frontmatter sits in the prompt; the body is fetched on activation.
 *
 * Compared to `OpenClawSkillDocument` (which lives in
 * `@veridex/agents-openclaw` as an *importer* type), `SkillContract`
 * is the runtime primitive: it carries triggers, resolver hints,
 * script/test manifests, and a stable `source` provenance record so
 * the resolver / packager / audit tools can reason about it.
 */

/** Stable kinds of skill — used by the resolver / UI for grouping. */
export type SkillKind =
  | 'workflow' // multi-step procedure
  | 'reference' // factual lookup / cheat-sheet
  | 'recovery' // failure-recovery routine
  | 'integration' // 3rd-party API guide
  | 'generic';

/** Where a skill came from. Authoritative for audit + DRY checks. */
export interface SkillSource {
  /** `inline` (defined in code), `pack` (installed pack), `file` (loose .md), `agent_authored` (skill_manage). */
  kind: 'inline' | 'pack' | 'file' | 'agent_authored';
  /** Pack id when `kind === 'pack'`. */
  packId?: string;
  /** Absolute filesystem path when applicable. */
  path?: string;
  /** Optional checksum (sha256 hex prefix) — used for integrity / cache invalidation. */
  hash?: string;
}

/**
 * Frontmatter sits in the prompt at low cost. Body does NOT —
 * agents fetch it via `load_skill(name)`. Keep this small.
 */
export interface SkillFrontmatter {
  /** Stable id (snake_case). Used by resolver and `load_skill`. */
  id: string;
  /** Short human label. */
  name?: string;
  /** Single-sentence summary — shown in the disclosed catalog. */
  description: string;
  /** Skill kind for UI / grouping. */
  kind?: SkillKind;
  /** Tags for grouping / search. */
  tags?: string[];
  /** When this skill applies — natural-language triggers, keywords, or regex. */
  triggers?: SkillTrigger[];
  /** Optional skill version (semver-ish). */
  version?: string;
  /** Optional pack id — set by the loader, not the author. */
  packId?: string;
  /** Forwards unknown frontmatter keys for tolerant interop. */
  [extra: string]: unknown;
}

/**
 * A trigger expresses when a skill is relevant.
 *
 * - `keyword` — case-insensitive substring match
 * - `phrase` — literal phrase match (word-boundary aware)
 * - `regex` — anchored regex (pattern + optional flags)
 * - `intent` — handle for a registered intent classifier (resolver
 *   strategy decides how to match these).
 */
export type SkillTrigger =
  | { type: 'keyword'; value: string }
  | { type: 'phrase'; value: string }
  | { type: 'regex'; pattern: string; flags?: string }
  | { type: 'intent'; value: string };

/** Manifest entry for a script bundled with a skill (deterministic helper). */
export interface SkillScriptRef {
  /** Logical name (e.g. `transfer.ts`). */
  name: string;
  /** Path relative to the skill root. */
  path: string;
  /** Optional command — when present, the runtime can invoke this script (sandboxed). */
  command?: string;
  /** Brief description for the agent. */
  description?: string;
}

/** Manifest entry for a tool contract bundled with the skill. */
export interface SkillToolRef {
  /** Tool name (must match an inline `ToolContract` registered alongside). */
  name: string;
  /** Brief description (mirrors `ToolContract.description` for skim). */
  description?: string;
}

/** Manifest entry for a test bundled with the skill. */
export interface SkillTestRef {
  name: string;
  path: string;
  /** Test kind: `unit` (vitest), `integration` (sandbox), `eval` (scenario). */
  kind: 'unit' | 'integration' | 'eval';
}

/**
 * The full skill contract. Body content is held by the registry but
 * NOT injected into the prompt unless `load_skill(id)` is called.
 */
export interface SkillContract {
  /** Stable id — matches `frontmatter.id`. */
  id: string;
  /** Parsed YAML frontmatter. */
  frontmatter: SkillFrontmatter;
  /** Markdown body (sans frontmatter). */
  body: string;
  /** Deterministic scripts bundled with the skill. */
  scripts?: SkillScriptRef[];
  /** Tool contracts bundled with the skill. */
  tools?: SkillToolRef[];
  /** Tests bundled with the skill (used by `check-resolvable` / CI). */
  tests?: SkillTestRef[];
  /** Provenance — where the skill came from. */
  source: SkillSource;
}

/** A lightweight summary used in the disclosed catalog. */
export interface SkillSummary {
  id: string;
  name?: string;
  description: string;
  kind: SkillKind;
  tags: string[];
  triggers: SkillTrigger[];
  packId?: string;
}

/** Result of `SkillResolver.resolve(intent)` — ranked candidate skills. */
export interface SkillMatch {
  skill: SkillSummary;
  /** Match score in [0,1]. Higher is better. */
  score: number;
  /** Triggers that fired — used for explainability. */
  matchedTriggers: SkillTrigger[];
  /** Human-readable reason ("keyword:transfer", "regex:/^pay/", "intent:payments"). */
  reasons: string[];
}
