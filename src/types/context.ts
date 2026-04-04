/**
 * @packageDocumentation
 * @module ContextTypes
 * @description
 * Context compilation types for the Veridex Agent Fabric.
 *
 * The context compiler assembles bounded context from system policy,
 * instructions, run state, runtime memory, governed workspace state,
 * evidence references, tools, budget, and constraints. Each section
 * has source, budget, priority, and truncation strategy.
 */

// ── Context Section ──

/** A single section of compiled context. */
export interface ContextSection {
  /** Section identifier */
  id: string;
  /** Section source (e.g., 'system', 'instructions', 'memory', 'tools') */
  source: ContextSource;
  /** The content of this section */
  content: string;
  /** Priority (higher = more important, less likely to be truncated) */
  priority: number;
  /** Token budget for this section (0 = unlimited) */
  budgetTokens: number;
  /** Actual token count after compilation */
  actualTokens: number;
  /** Truncation strategy if budget is exceeded */
  truncation: TruncationStrategy;
  /** Whether this section was truncated */
  wasTruncated: boolean;
}

/** Source type for context sections. */
export type ContextSource =
  | 'system'
  | 'instructions'
  | 'context'
  | 'run_state'
  | 'memory'
  | 'workspace_state'
  | 'derived_memory'
  | 'evidence'
  | 'tools'
  | 'budget'
  | 'payment_constraints'
  | 'trust_constraints'
  | 'policy_overlay'
  | 'custom';

/** Strategy for truncating context sections that exceed their budget. */
export type TruncationStrategy =
  | 'tail'     // Remove from the end
  | 'head'     // Remove from the beginning
  | 'middle'   // Remove from the middle, keep start and end
  | 'summarize' // Attempt to summarize (future: model-based)
  | 'drop';     // Drop the entire section

// ── Context Plan ──

/** The compiled context plan ready for model consumption. */
export interface ContextPlan {
  /** All compiled context sections */
  sections: ContextSection[];
  /** Total token count across all sections */
  totalTokens: number;
  /** Token budget for the entire context */
  budgetTokens: number;
  /** Whether any section was truncated */
  hadTruncation: boolean;
  /** Compilation timestamp */
  compiledAt: number;
}

// ── Context Compiler Options ──

/** Options for context compilation. */
export interface ContextCompilerOptions {
  /** Total token budget for context */
  maxTokens: number;
  /** Sections to include */
  sections: ContextSectionInput[];
  /** Whether to include tool definitions in context */
  includeTools?: boolean;
  /** Whether to include memory in context */
  includeMemory?: boolean;
  /** Whether to include run history in context */
  includeHistory?: boolean;
  /** Maximum turns of history to include */
  maxHistoryTurns?: number;
}

/** Input for a context section before compilation. */
export interface ContextSectionInput {
  /** Section identifier */
  id: string;
  /** Section source */
  source: ContextSource;
  /** Raw content */
  content: string;
  /** Priority (higher = kept over lower) */
  priority: number;
  /** Optional token budget override for this section */
  budgetTokens?: number;
  /** Truncation strategy (default: 'tail') */
  truncation?: TruncationStrategy;
}

// ── Retrieval Policy ──

/** Per-source defaults applied by a retrieval policy. */
export interface ContextSourceConfig {
  /** Default priority for this source if the section does not specify one */
  defaultPriority: number;
  /** Default token budget for this source */
  defaultBudgetTokens?: number;
  /** Default truncation strategy */
  defaultTruncation?: TruncationStrategy;
}

/**
 * A retrieval policy defines the canonical ordering and per-source
 * defaults the compiler uses when assembling context.
 *
 * Sections are first grouped by sourceOrder position, then by
 * individual priority within each group. This ensures governed
 * workspace state is always considered before transient memory
 * regardless of the caller-supplied priority numbers.
 */
export interface ContextRetrievalPolicy {
  /** Canonical source ordering (first = highest precedence group). */
  sourceOrder: ContextSource[];
  /** Per-source config overrides. */
  sourceConfig?: Partial<Record<ContextSource, ContextSourceConfig>>;
}
