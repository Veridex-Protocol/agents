/**
 * @packageDocumentation
 * @module ToolRegistry
 * @description
 * Registry for tool contracts. Provides registration, lookup, and listing.
 */

import type { ToolContract } from '../types/tools';
import { lintToolContract, type ToolLintIssue } from './tool';

export class ToolRegistry {
  private tools = new Map<string, ToolContract>();

  /** Register a tool contract. */
  register(tool: ToolContract): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Get a tool by name. */
  get(name: string): ToolContract | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** List all registered tool names. */
  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Get all registered tools. */
  getAll(): ToolContract[] {
    return Array.from(this.tools.values());
  }

  /** Remove a tool. */
  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Clear all tools. */
  clear(): void {
    this.tools.clear();
  }

  /**
   * Lint every registered tool against the description-discipline rules.
   * Returns one entry per tool with the issues found.
   *
   * Intended for use in CI / development boot, not on every register
   * call — some hosts deliberately ship terse tool descriptions.
   */
  lint(): Array<{ name: string; issues: ToolLintIssue[] }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      issues: lintToolContract(t),
    }));
  }
}
