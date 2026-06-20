/**
 * @packageDocumentation
 * @module ExecutionSurfaceRegistry
 * @description
 * Registry for all executable capabilities visible to the runtime.
 */

import type { ExecutableCapability, ExecutionSurfaceSummary } from '../types/execution';
import type { ToolContract } from '../types/tools';

const _CAPABILITY_SOURCES: Array<ExecutableCapability['source']> = [
  'local_tool',
  'mcp',
  'a2a',
  'acp',
  'adapter',
];

export class ExecutionSurfaceRegistry {
  private capabilities = new Map<string, ExecutableCapability>();

  register(capability: ExecutableCapability): void {
    if (this.capabilities.has(capability.name)) {
      throw new Error(`Capability '${capability.name}' is already registered`);
    }
    this.capabilities.set(capability.name, capability);
  }

  registerTool(tool: ToolContract): void {
    this.register({
      name: tool.name,
      source: 'local_tool',
      description: tool.description,
      safetyClass: tool.safetyClass,
      inputSchema: tool.input,
      tool,
      execute: tool.execute,
      permissions: tool.permissions,
      costEstimate: tool.costEstimate,
      metadata: tool.metadata,
    });
  }

  get(name: string): ExecutableCapability | undefined {
    return this.capabilities.get(name);
  }

  has(name: string): boolean {
    return this.capabilities.has(name);
  }

  getAll(): ExecutableCapability[] {
    return Array.from(this.capabilities.values());
  }

  list(): string[] {
    return Array.from(this.capabilities.keys()).sort();
  }

  remove(name: string): boolean {
    return this.capabilities.delete(name);
  }

  clear(): void {
    this.capabilities.clear();
  }

  summary(): ExecutionSurfaceSummary {
    const bySource = {
      local_tool: 0,
      mcp: 0,
      a2a: 0,
      acp: 0,
      adapter: 0,
    } satisfies Record<ExecutableCapability['source'], number>;

    for (const capability of this.capabilities.values()) {
      bySource[capability.source] += 1;
    }

    return {
      total: this.capabilities.size,
      bySource,
      names: this.list(),
    };
  }
}
