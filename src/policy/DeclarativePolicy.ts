/**
 * @module DeclarativePolicyLoader
 * @description
 * Compile a declarative policy document (YAML or JSON, parsed to a JS object
 * by the caller) into concrete `PolicyRule[]` objects wired to built-in
 * verbs. This lets teams author policy-as-config instead of code, ship it in
 * git, and review it in PRs without touching the TS surface.
 *
 * Design notes:
 *   • We deliberately DO NOT bundle a YAML parser. `@veridex/agents` tries to
 *     stay dep-light; callers plug in `yaml`, `js-yaml`, or `JSON.parse` as
 *     they see fit and hand us the parsed object. This keeps the loader
 *     portable across Node, Bun, Deno, Cloudflare Workers, etc.
 *   • The schema is validated with Zod — any shape violation is a loud
 *     load-time error, not a runtime surprise mid-agent-turn.
 *   • Each supported verb maps to an existing built-in rule function. Adding
 *     a new verb is a two-line change: extend the schema + add a case in the
 *     compiler. There is no `eval`, no dynamic require — all verbs are
 *     enumerated on purpose so a hostile policy file cannot escalate.
 *   • Every compiled rule keeps the author-supplied `id` and `description`
 *     so audit trails remain human-readable.
 *
 * Supported schema (v1):
 *
 *   version: 1
 *   rules:
 *     - id: payments-require-approval
 *       description: "All financial ops require human approval"
 *       verb: require-approval-for-safety-classes
 *       classes: [write_financial]
 *
 *     - id: cap-run-spend
 *       verb: max-run-spend-usd
 *       limit: 5.00
 *
 *     - id: allow-mainnets-only
 *       verb: allow-chains
 *       chains: [base, ethereum, solana]
 *
 *     - id: block-shell
 *       verb: block-safety-classes
 *       classes: [write_system]
 *
 *     - id: max-tokens
 *       verb: max-token-budget
 *       limit: 200000
 *
 *     - id: require-envelope
 *       verb: require-verified-envelope
 *       riskBump: 0.5
 */

import { z } from 'zod';
import type { ToolContract, ToolSafetyClass } from '../types/tools';
import {
  blockSafetyClasses,
  requireApprovalFor,
  maxRunSpendUSD,
  maxTokenBudget,
  allowChains,
  requireVerifiedEnvelope,
  type PolicyRule,
} from './PolicyEngine';

// ── Schema ──

const SafetyClassSchema = z.enum([
  'read_public',
  'read_private',
  'write_memory',
  'write_financial',
  'write_system',
  'call_external',
]);

const RuleBaseSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  priority: z.number().int().optional(),
});

const RuleSchema = z.discriminatedUnion('verb', [
  RuleBaseSchema.extend({
    verb: z.literal('block-safety-classes'),
    classes: z.array(SafetyClassSchema).min(1),
  }),
  RuleBaseSchema.extend({
    verb: z.literal('require-approval-for-safety-classes'),
    classes: z.array(SafetyClassSchema).min(1),
  }),
  RuleBaseSchema.extend({
    verb: z.literal('max-run-spend-usd'),
    limit: z.number().positive(),
  }),
  RuleBaseSchema.extend({
    verb: z.literal('max-token-budget'),
    limit: z.number().int().positive(),
  }),
  RuleBaseSchema.extend({
    verb: z.literal('allow-chains'),
    chains: z.array(z.string().min(1)).min(1),
  }),
  RuleBaseSchema.extend({
    verb: z.literal('require-verified-envelope'),
    riskBump: z.number().min(0).max(1).optional(),
  }),
]);

export const DeclarativePolicySchema = z.object({
  version: z.literal(1),
  name: z.string().optional(),
  description: z.string().optional(),
  rules: z.array(RuleSchema).min(1),
});

export type DeclarativePolicy = z.infer<typeof DeclarativePolicySchema>;
export type DeclarativePolicyRule = z.infer<typeof RuleSchema>;
export type PolicyVerb = DeclarativePolicyRule['verb'];

// ── Compiler ──

export interface CompileOptions {
  /**
   * Tool contract registry. Required only when the policy references
   * safety-class-based verbs (`block-safety-classes`,
   * `require-approval-for-safety-classes`). If omitted and a rule needs it,
   * compilation throws.
   */
  tools?: Map<string, ToolContract>;
}

/**
 * Validate + compile a parsed policy object into concrete `PolicyRule[]`.
 * Input is the already-parsed JS object (from YAML, JSON, or hand-built).
 */
export function compileDeclarativePolicy(
  input: unknown,
  options: CompileOptions = {},
): PolicyRule[] {
  const policy = DeclarativePolicySchema.parse(input);

  // Reject duplicate ids — silent collisions lead to confusing audits.
  const seen = new Set<string>();
  for (const r of policy.rules) {
    if (seen.has(r.id)) {
      throw new Error(`DeclarativePolicy: duplicate rule id '${r.id}'`);
    }
    seen.add(r.id);
  }

  return policy.rules.map((raw) => compileRule(raw, options));
}

function compileRule(raw: DeclarativePolicyRule, options: CompileOptions): PolicyRule {
  const description = raw.description ?? describeDefault(raw);

  let base: PolicyRule;
  switch (raw.verb) {
    case 'block-safety-classes': {
      const tools = requireToolMap(options.tools, raw.verb);
      base = blockSafetyClasses(raw.classes as unknown as ToolSafetyClass[], tools);
      break;
    }
    case 'require-approval-for-safety-classes': {
      const tools = requireToolMap(options.tools, raw.verb);
      base = requireApprovalFor(raw.classes as unknown as ToolSafetyClass[], tools);
      break;
    }
    case 'max-run-spend-usd':
      base = maxRunSpendUSD(raw.limit);
      break;
    case 'max-token-budget':
      base = maxTokenBudget(raw.limit);
      break;
    case 'allow-chains':
      base = allowChains(raw.chains);
      break;
    case 'require-verified-envelope':
      base = requireVerifiedEnvelope(raw.riskBump ?? 0.5);
      break;
    default: {
      // Exhaustiveness guard — TS will catch at compile time, Zod at runtime.
      const _exhaustive: never = raw;
      throw new Error(`DeclarativePolicy: unknown verb ${(_exhaustive as any)?.verb}`);
    }
  }

  // Override id/description/priority with the author's values so audit logs
  // surface the human-chosen identifier rather than `builtin:*`.
  return {
    ...base,
    id: raw.id,
    name: base.name,
    description,
    priority: raw.priority ?? base.priority,
    evaluate: base.evaluate.bind(base),
  };
}

function describeDefault(raw: DeclarativePolicyRule): string {
  switch (raw.verb) {
    case 'block-safety-classes':
      return `Block safety classes: ${raw.classes.join(', ')}`;
    case 'require-approval-for-safety-classes':
      return `Require approval for safety classes: ${raw.classes.join(', ')}`;
    case 'max-run-spend-usd':
      return `Block when run spend exceeds $${raw.limit}`;
    case 'max-token-budget':
      return `Block when token usage exceeds ${raw.limit}`;
    case 'allow-chains':
      return `Allow only chains: ${raw.chains.join(', ')}`;
    case 'require-verified-envelope':
      return `Flag when response envelope / integrity binding is missing`;
  }
}

function requireToolMap(
  tools: Map<string, ToolContract> | undefined,
  verb: PolicyVerb,
): Map<string, ToolContract> {
  if (!tools) {
    throw new Error(
      `DeclarativePolicy: verb '${verb}' requires a tool contract map. ` +
        `Pass it via compileDeclarativePolicy(doc, { tools }).`,
    );
  }
  return tools;
}
