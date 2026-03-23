/**
 * @packageDocumentation
 * @module ToolValidator
 * @description
 * Validates tool inputs against their schemas.
 */

import type { ToolContract, ToolSafetyClass } from '../types/tools';

export class ToolValidator {
  /**
   * Validate tool input against the tool's schema.
   * Returns error message string or undefined if valid.
   */
  validateInput(tool: ToolContract, input: Record<string, unknown>): string | undefined {
    const schema = tool.input;

    // Zod schema (has .safeParse method)
    if (schema && typeof schema === 'object' && 'safeParse' in schema && typeof schema.safeParse === 'function') {
      const result = schema.safeParse(input);
      if (!result.success) {
        return `Input validation failed: ${result.error.message}`;
      }
      return undefined;
    }

    // JSON Schema — basic type checking (full JSON Schema validation is out of scope)
    if (schema && typeof schema === 'object' && 'type' in schema) {
      const jsonSchema = schema as Record<string, unknown>;
      if (jsonSchema.required && Array.isArray(jsonSchema.required)) {
        for (const field of jsonSchema.required) {
          if (!(field in input)) {
            return `Missing required field: ${field}`;
          }
        }
      }
    }

    return undefined;
  }

  /** Check if a tool's safety class requires approval. */
  requiresApproval(
    safetyClass: ToolSafetyClass,
    requireApprovalFor?: ToolSafetyClass[],
  ): boolean {
    const defaultApprovalRequired: ToolSafetyClass[] = ['financial', 'destructive', 'privileged'];
    const classes = requireApprovalFor ?? defaultApprovalRequired;
    return classes.includes(safetyClass);
  }
}
