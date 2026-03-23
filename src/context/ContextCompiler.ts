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
  TruncationStrategy,
} from '../types/context';

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
