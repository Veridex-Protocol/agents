/**
 * @module surfaces
 *
 * Harness surface abstraction for eval-driven optimization.
 *
 * A **surface** is a single tunable aspect of an agent configuration
 * (instructions, tools, policies, hooks, or a custom key).  A **variant** is
 * an immutable snapshot of one or more surface values that can be applied to
 * an `AgentDefinition` for evaluation.
 *
 * This module provides utilities to:
 * - Extract surfaces from an existing `AgentDefinition`
 * - Build typed variants
 * - Apply a variant back to a definition (pure, returns new object)
 * - Diff two variants to identify what changed
 */

import type { AgentDefinition } from '../types/agent';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

/** The kind of surface being tuned. */
export type HarnessSurfaceKind =
  | 'instructions'
  | 'tools'
  | 'policies'
  | 'hooks'
  | 'context_policy'
  | 'custom';

/** A single tunable surface extracted from (or destined for) an AgentDefinition. */
export interface HarnessSurface {
  /** Human-readable surface name (e.g. "instructions", "tools"). */
  name: string;
  /** Surface kind for routing. */
  kind: HarnessSurfaceKind;
  /** The current value of the surface (deep-cloned from the definition). */
  value: unknown;
}

/** An immutable snapshot of one or more surface values used for evaluation. */
export interface HarnessVariant {
  /** Human-readable label for this variant. */
  label: string;
  /** The full set of surfaces in this variant. */
  surfaces: HarnessSurface[];
  /** Returns a serialisable representation. */
  toJSON(): Record<string, unknown>;
}

/** Result of diffing two variants. */
export interface VariantDiff {
  /** Surface names that were added in `b` relative to `a`. */
  added: string[];
  /** Surface names that were removed in `b` relative to `a`. */
  removed: string[];
  /** Surface names whose value changed between `a` and `b`. */
  changed: string[];
  /** Human-readable summary of what changed. */
  summary: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, Object.keys(v as Record<string, unknown>).sort());
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Extract tunable surfaces from an `AgentDefinition`.
 *
 * Only surfaces that are defined (not `undefined`) on the definition are
 * returned, so the caller can see which knobs are currently set.
 */
export function extractSurfaces(def: AgentDefinition): HarnessSurface[] {
  const surfaces: HarnessSurface[] = [];

  surfaces.push({
    name: 'instructions',
    kind: 'instructions',
    value: clone(def.instructions),
  });

  if (def.tools) {
    surfaces.push({ name: 'tools', kind: 'tools', value: clone(def.tools) });
  }
  if (def.policies) {
    surfaces.push({ name: 'policies', kind: 'policies', value: clone(def.policies) });
  }
  if (def.hooks) {
    surfaces.push({ name: 'hooks', kind: 'hooks', value: clone(def.hooks) });
  }

  return surfaces;
}

/**
 * Build a variant from a set of surfaces.
 */
export function buildVariant(label: string, surfaces: HarnessSurface[]): HarnessVariant {
  const frozen = clone(surfaces);
  return {
    label,
    surfaces: frozen,
    toJSON() {
      return {
        label: this.label,
        surfaces: this.surfaces.map((s) => ({ name: s.name, kind: s.kind, value: s.value })),
      };
    },
  };
}

/**
 * Convenience: build a variant directly from an `AgentDefinition`.
 */
export function buildVariantFromDef(label: string, def: AgentDefinition): HarnessVariant {
  return buildVariant(label, extractSurfaces(def));
}

/**
 * Apply a variant to a base `AgentDefinition`, returning a new definition
 * with the variant surfaces merged in.  The original definition is not mutated.
 */
export function applyVariant(variant: HarnessVariant, baseDef: AgentDefinition): AgentDefinition {
  const next = clone(baseDef);

  for (const surface of variant.surfaces) {
    switch (surface.kind) {
      case 'instructions':
        next.instructions = clone(surface.value) as string;
        break;
      case 'tools':
        next.tools = clone(surface.value) as AgentDefinition['tools'];
        break;
      case 'policies':
        next.policies = clone(surface.value) as AgentDefinition['policies'];
        break;
      case 'hooks':
        next.hooks = clone(surface.value) as AgentDefinition['hooks'];
        break;
      case 'context_policy':
      case 'custom':
        // Store in metadata under the surface name
        if (!next.metadata) next.metadata = {};
        next.metadata[surface.name] = clone(surface.value);
        break;
    }
  }

  return next;
}

/**
 * Diff two variants, returning which surfaces were added, removed, or changed.
 */
export function diffVariants(a: HarnessVariant, b: HarnessVariant): VariantDiff {
  const aMap = new Map(a.surfaces.map((s) => [s.name, s]));
  const bMap = new Map(b.surfaces.map((s) => [s.name, s]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [name] of bMap) {
    if (!aMap.has(name)) {
      added.push(name);
    }
  }

  for (const [name, aSurface] of aMap) {
    const bSurface = bMap.get(name);
    if (!bSurface) {
      removed.push(name);
    } else if (stableStringify(aSurface.value) !== stableStringify(bSurface.value)) {
      changed.push(name);
    }
  }

  const parts: string[] = [];
  if (added.length) parts.push(`added: ${added.join(', ')}`);
  if (removed.length) parts.push(`removed: ${removed.join(', ')}`);
  if (changed.length) parts.push(`changed: ${changed.join(', ')}`);
  const summary = parts.length ? parts.join('; ') : 'no differences';

  return { added, removed, changed, summary };
}
