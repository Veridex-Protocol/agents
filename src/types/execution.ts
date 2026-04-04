/**
 * @packageDocumentation
 * @module ExecutionTypes
 * @description
 * Canonical execution-surface metadata for local tools, remote transports, and adapters.
 */

import type {
  CostEstimate,
  ToolContract,
  ToolExecuteParams,
  ToolResult,
  ToolSafetyClass,
} from './tools';
import type { BrowserCapabilityMetadata } from './accountability';

export type CapabilitySource =
  | 'local_tool'
  | 'mcp'
  | 'a2a'
  | 'acp'
  | 'adapter';

export type ExecutionCapabilityKind =
  | 'tool'
  | 'browser'
  | 'handoff';

export interface ExecutableCapability<TInput = unknown> {
  /** Capability name exposed to the runtime/model. */
  name: string;
  /** Capability category. */
  kind?: ExecutionCapabilityKind;
  /** Where this capability originated. */
  source: CapabilitySource;
  /** Human-readable description. */
  description: string;
  /** Safety classification used by policies and approvals. */
  safetyClass: ToolSafetyClass;
  /** Input schema when the capability should be exposed to the model. */
  inputSchema?: ToolContract<TInput>['input'] | Record<string, unknown>;
  /** Underlying local tool when this capability wraps one. */
  tool?: ToolContract<TInput>;
  /** Execute the capability. */
  execute: (params: ToolExecuteParams<TInput>) => Promise<ToolResult>;
  /** Optional permissions metadata. */
  permissions?: string[];
  /** Optional cost estimate. */
  costEstimate?: (input: TInput) => CostEstimate;
  /** Optional source provenance for imported capabilities. */
  adapterHint?: string;
  /** Optional browser/session metadata for interactive execution capabilities. */
  browser?: BrowserCapabilityMetadata;
  /** Additional metadata. */
  metadata?: Record<string, unknown>;
}

export interface ExecutionSurfaceSummary {
  /** Total registered capabilities. */
  total: number;
  /** Counts by capability source. */
  bySource: Record<CapabilitySource, number>;
  /** Registered names in sorted order. */
  names: string[];
}
