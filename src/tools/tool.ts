/**
 * @packageDocumentation
 * @module tool
 * @description
 * Convenience helper for creating typed tool contracts.
 *
 * Encodes Anthropic's "Writing tools for agents" guidance:
 *   - Structured `guidance` fields (summary, whenToUse, whenNotToUse,
 *     successExample) compile into a description that answers the four
 *     questions a model needs to choose tools well.
 *   - `errorTemplates` shape failure messages into actionable feedback
 *     instead of opaque codes ("Token limit 500 exceeded — summarise the
 *     input or pass a smaller chunk." beats "400 Bad Request").
 *   - `lintToolContract()` flags tools that are likely to underperform
 *     (no when-to-use, terse description, missing error templates) so the
 *     framework can warn at construct time instead of in production.
 */

import type { z } from 'zod';
import type {
  ToolContract,
  ToolSafetyClass,
  ToolResult,
  ToolExecuteParams,
  CostEstimate,
  ToolDescriptionGuidance,
  ToolErrorTemplates,
} from '../types/tools';

/** Options for the `tool()` helper function. */
export interface ToolOptions<TInput, TOutput> {
  name: string;
  /**
   * Optional pre-composed description. If omitted, `guidance` is used to
   * build one. Provide this if you want full control of the prose the
   * model sees, or both for documentation completeness.
   */
  description?: string;
  /**
   * Structured guidance: summary, when-to-use, when-not-to-use, success
   * example. The recommended way to author tool descriptions; the helper
   * compiles these into the `description` string surfaced to the model.
   */
  guidance?: ToolDescriptionGuidance;
  input: z.ZodType<TInput>;
  output?: z.ZodType<TOutput>;
  safetyClass: ToolSafetyClass;
  execute: (params: ToolExecuteParams<TInput>) => Promise<ToolResult>;
  timeoutMs?: number;
  retries?: number;
  idempotent?: boolean;
  permissions?: string[];
  costEstimate?: (input: TInput) => CostEstimate;
  /**
   * Error message templates. Apply with `formatToolError(tool, code, ctx)`
   * to produce a model-actionable error string from a stable error code.
   */
  errorTemplates?: ToolErrorTemplates;
  metadata?: Record<string, unknown>;
}

/**
 * Compile structured guidance into the single description string that
 * model providers actually see. Stable, deterministic ordering so prompt
 * caches stay warm across construction.
 */
export function compileToolDescription(
  guidance: ToolDescriptionGuidance,
  fallback?: string,
): string {
  const parts: string[] = [];
  if (guidance.summary) parts.push(guidance.summary.trim());
  else if (fallback) parts.push(fallback.trim());

  if (guidance.whenToUse && guidance.whenToUse.length > 0) {
    parts.push(
      `Use when:\n${guidance.whenToUse.map((b) => `  - ${b.trim()}`).join('\n')}`,
    );
  }
  if (guidance.whenNotToUse && guidance.whenNotToUse.length > 0) {
    parts.push(
      `Do NOT use when:\n${guidance.whenNotToUse.map((b) => `  - ${b.trim()}`).join('\n')}`,
    );
  }
  if (guidance.successExample) {
    parts.push(`Successful result: ${guidance.successExample.trim()}`);
  }
  return parts.join('\n\n');
}

/**
 * Apply an error template to produce a model-actionable error string.
 *
 * @example
 * ```ts
 * return {
 *   success: false,
 *   llmOutput: '',
 *   error: formatToolError(myTool, 'rate_limited', {
 *     message: err.message,
 *     retryAfter: 30,
 *   }),
 * };
 * ```
 */
export function formatToolError(
  tool: Pick<ToolContract, 'errorTemplates' | 'name'>,
  code: string,
  details: { message?: string; [key: string]: unknown } = {},
): string {
  const templates = tool.errorTemplates;
  const tpl =
    templates?.byCode?.[code] ??
    templates?.default ??
    `${tool.name} failed (${code}): {message}`;
  return tpl.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key === 'code') return code;
    const v = details[key];
    return v === undefined || v === null ? match : String(v);
  });
}

/** A lint diagnostic produced by `lintToolContract()`. */
export interface ToolLintIssue {
  /** Stable code so callers can selectively allow/deny. */
  code:
    | 'description_missing'
    | 'description_short'
    | 'guidance_missing_when_to_use'
    | 'guidance_missing_when_not_to_use'
    | 'name_not_verb_phrase'
    | 'no_error_templates'
    | 'destructive_without_idempotency_signal';
  severity: 'error' | 'warn' | 'info';
  message: string;
}

const VERB_PHRASE = /^[a-z][a-z0-9_]*$/;
const MIN_DESCRIPTION_LENGTH = 40;

/**
 * Lint a tool contract for the patterns that correlate with poor model
 * performance. Cheap to run at construct time; surfaces problems before
 * a single token is spent.
 */
export function lintToolContract(contract: ToolContract): ToolLintIssue[] {
  const issues: ToolLintIssue[] = [];

  if (!contract.description || contract.description.trim().length === 0) {
    issues.push({
      code: 'description_missing',
      severity: 'error',
      message: `Tool "${contract.name}" has no description.`,
    });
  } else if (contract.description.trim().length < MIN_DESCRIPTION_LENGTH) {
    issues.push({
      code: 'description_short',
      severity: 'warn',
      message: `Tool "${contract.name}" description is shorter than ${MIN_DESCRIPTION_LENGTH} chars; the model has little to go on.`,
    });
  }

  const g = contract.guidance;
  if (!g || !g.whenToUse || g.whenToUse.length === 0) {
    issues.push({
      code: 'guidance_missing_when_to_use',
      severity: 'warn',
      message: `Tool "${contract.name}" has no \`guidance.whenToUse\`. Models pick tools by name + when-to-use cues.`,
    });
  }
  if (!g || !g.whenNotToUse || g.whenNotToUse.length === 0) {
    issues.push({
      code: 'guidance_missing_when_not_to_use',
      severity: 'info',
      message: `Tool "${contract.name}" has no \`guidance.whenNotToUse\`. Anti-patterns prevent retry loops on the wrong tool.`,
    });
  }

  if (!VERB_PHRASE.test(contract.name)) {
    issues.push({
      code: 'name_not_verb_phrase',
      severity: 'info',
      message: `Tool name "${contract.name}" is not a snake_case verb phrase. Models pick tools by name; \`fetch_balance\` reads better than \`BalanceFetcher\`.`,
    });
  }

  const hasTemplates =
    contract.errorTemplates &&
    (contract.errorTemplates.default ||
      Object.keys(contract.errorTemplates.byCode ?? {}).length > 0);
  if (!hasTemplates) {
    issues.push({
      code: 'no_error_templates',
      severity: 'info',
      message: `Tool "${contract.name}" has no \`errorTemplates\`. Model-actionable error messages reduce retry loops by ~40%.`,
    });
  }

  if (
    (contract.safetyClass === 'destructive' || contract.safetyClass === 'financial') &&
    contract.idempotent === undefined
  ) {
    issues.push({
      code: 'destructive_without_idempotency_signal',
      severity: 'warn',
      message: `Tool "${contract.name}" is ${contract.safetyClass} but did not declare \`idempotent\`. The runtime will assume non-idempotent and disable retries.`,
    });
  }

  return issues;
}

/**
 * Create a typed tool contract.
 *
 * @example
 * ```ts
 * const fetchBalance = tool({
 *   name: 'fetch_balance',
 *   guidance: {
 *     summary: 'Fetch the on-chain balance for a wallet.',
 *     whenToUse: [
 *       'The user asks "how much X do I have?".',
 *       'Before drafting a transaction that requires sufficient balance.',
 *     ],
 *     whenNotToUse: [
 *       'Computing historical balance — use `fetch_balance_at_block` instead.',
 *       'Listing every token in a wallet — use `list_token_holdings`.',
 *     ],
 *     successExample: '{ "balance": "1.234", "symbol": "ETH", "chain": "ethereum" }',
 *   },
 *   input: z.object({ address: z.string() }),
 *   safetyClass: 'read',
 *   errorTemplates: {
 *     byCode: {
 *       not_found: 'No wallet found at {address}. Verify the address is correct and on the requested chain.',
 *       rate_limited: 'RPC rate-limited. Retry after {retryAfter}s, or batch multiple calls into a single fetch.',
 *     },
 *     default: 'fetch_balance failed: {message}',
 *   },
 *   async execute({ input }) {
 *     return { llmOutput: `Balance: 100`, success: true };
 *   },
 * });
 * ```
 */
export function tool<TInput = unknown, TOutput = unknown>(
  options: ToolOptions<TInput, TOutput>,
): ToolContract<TInput, TOutput> {
  const description = options.description
    ? options.description
    : options.guidance
      ? compileToolDescription(options.guidance)
      : '';

  return {
    name: options.name,
    description,
    guidance: options.guidance,
    input: options.input,
    output: options.output,
    safetyClass: options.safetyClass,
    execute: options.execute,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    idempotent: options.idempotent,
    permissions: options.permissions,
    costEstimate: options.costEstimate,
    errorTemplates: options.errorTemplates,
    metadata: options.metadata,
  };
}
