/**
 * @packageDocumentation
 * @module ContextCompiler
 * @description
 * Compiles bounded context for model consumption.
 * Handles token budgeting, priority-based truncation, and section assembly.
 */

import type {
  ContextPlan,
  ContextSection,
  ContextSectionInput,
  ContextCompilerOptions,
  ContextRetrievalPolicy,
  TruncationStrategy,
} from '../types/context';

/** Default retrieval policy encoding the governed-state-first ordering. */
export const DEFAULT_RETRIEVAL_POLICY: ContextRetrievalPolicy = {
  sourceOrder: [
    'system',
    'instructions',
    'policy_overlay',
    'trust_constraints',
    'payment_constraints',
    'run_state',
    'budget',
    'workspace_state',
    'derived_memory',
    'memory',
    'evidence',
    'tools',
    'context',
    'custom',
  ],
};

export class ContextCompiler {
  /**
   * Compile context sections within a token budget.
   * Sections are prioritized (higher = kept first) and truncated as needed.
   */
  compile(options: ContextCompilerOptions): ContextPlan {
    const { maxTokens, sections: inputs } = options;

    // Sort by priority descending (highest priority first)
    const sorted = [...inputs].sort((a, b) => b.priority - a.priority);

    let remainingTokens = maxTokens;
    const compiledSections: ContextSection[] = [];

    for (const input of sorted) {
      const estimatedTokens = this.estimateTokens(input.content);
      const sectionBudget = input.budgetTokens
        ? Math.min(input.budgetTokens, remainingTokens)
        : remainingTokens;

      if (sectionBudget <= 0) {
        // No budget left — drop or add empty
        compiledSections.push(this.createSection(input, '', 0, true));
        continue;
      }

      if (estimatedTokens <= sectionBudget) {
        // Fits within budget
        compiledSections.push(this.createSection(input, input.content, estimatedTokens, false));
        remainingTokens -= estimatedTokens;
      } else {
        // Needs truncation
        const strategy = input.truncation ?? 'tail';
        const truncated = this.truncate(input.content, sectionBudget, strategy);
        const truncatedTokens = this.estimateTokens(truncated);
        compiledSections.push(this.createSection(input, truncated, truncatedTokens, true));
        remainingTokens -= truncatedTokens;
      }
    }

    const totalTokens = compiledSections.reduce((sum, s) => sum + s.actualTokens, 0);

    return {
      sections: compiledSections,
      totalTokens,
      budgetTokens: maxTokens,
      hadTruncation: compiledSections.some((s) => s.wasTruncated),
      compiledAt: Date.now(),
    };
  }

  /**
   * Estimate token count for a string.
   * Uses a simple heuristic (~4 chars per token). Good enough for budgeting;
   * model-specific tokenizers can override this.
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Compile context sections using a retrieval policy.
   *
   * Sections are first grouped by their source's position in the
   * policy's `sourceOrder`, then by individual priority within each
   * group. Per-source defaults from `sourceConfig` fill in missing
   * priority, budget, and truncation values.
   */
  compileWithPolicy(
    options: ContextCompilerOptions,
    policy: ContextRetrievalPolicy = DEFAULT_RETRIEVAL_POLICY,
  ): ContextPlan {
    const { maxTokens, sections: inputs } = options;
    const orderIndex = new Map(policy.sourceOrder.map((s, i) => [s, i]));
    const fallbackIndex = policy.sourceOrder.length;

    const enriched = inputs.map((input) => {
      const cfg = policy.sourceConfig?.[input.source];
      return {
        ...input,
        priority: input.priority ?? cfg?.defaultPriority ?? 50,
        budgetTokens: input.budgetTokens ?? cfg?.defaultBudgetTokens,
        truncation: input.truncation ?? cfg?.defaultTruncation ?? ('tail' as const),
      };
    });

    // Sort: source-group position first (ascending), then priority within group (descending).
    enriched.sort((a, b) => {
      const groupA = orderIndex.get(a.source) ?? fallbackIndex;
      const groupB = orderIndex.get(b.source) ?? fallbackIndex;
      if (groupA !== groupB) return groupA - groupB;
      return b.priority - a.priority;
    });

    let remainingTokens = maxTokens;
    const compiledSections: ContextSection[] = [];

    for (const input of enriched) {
      const estimatedTokens = this.estimateTokens(input.content);
      const sectionBudget = input.budgetTokens
        ? Math.min(input.budgetTokens, remainingTokens)
        : remainingTokens;

      if (sectionBudget <= 0) {
        compiledSections.push(this.createSection(input, '', 0, true));
        continue;
      }

      if (estimatedTokens <= sectionBudget) {
        compiledSections.push(this.createSection(input, input.content, estimatedTokens, false));
        remainingTokens -= estimatedTokens;
      } else {
        const strategy = input.truncation ?? 'tail';
        const truncated = this.truncate(input.content, sectionBudget, strategy);
        const truncatedTokens = this.estimateTokens(truncated);
        compiledSections.push(this.createSection(input, truncated, truncatedTokens, true));
        remainingTokens -= truncatedTokens;
      }
    }

    const totalTokens = compiledSections.reduce((sum, s) => sum + s.actualTokens, 0);

    return {
      sections: compiledSections,
      totalTokens,
      budgetTokens: maxTokens,
      hadTruncation: compiledSections.some((s) => s.wasTruncated),
      compiledAt: Date.now(),
    };
  }

  /** Truncate content to fit within a token budget using the given strategy. */
  private truncate(content: string, budgetTokens: number, strategy: TruncationStrategy): string {
    if (strategy === 'drop') return '';

    const maxChars = budgetTokens * 4;

    switch (strategy) {
      case 'tail':
        return content.slice(0, maxChars);

      case 'head':
        return content.slice(-maxChars);

      case 'middle': {
        const half = Math.floor(maxChars / 2);
        const start = content.slice(0, half);
        const end = content.slice(-half);
        return `${start}\n...[truncated]...\n${end}`;
      }

      case 'summarize':
        // Summarization would require model calls — fall back to tail truncation
        return content.slice(0, maxChars);

      default:
        return content.slice(0, maxChars);
    }
  }

  private createSection(
    input: ContextSectionInput,
    content: string,
    actualTokens: number,
    wasTruncated: boolean,
  ): ContextSection {
    return {
      id: input.id,
      source: input.source,
      content,
      priority: input.priority,
      budgetTokens: input.budgetTokens ?? 0,
      actualTokens,
      truncation: input.truncation ?? 'tail',
      wasTruncated,
    };
  }
}
