/**
 * @packageDocumentation
 * @module BootstrapTypes
 * @description
 * Runtime bootstrap and setup report types for the Veridex Agent Fabric.
 */

import type { CapabilitySource } from './execution';
import type { TranscriptStoreMode } from './transcript';

export type TransportKind = 'mcp' | 'acp' | 'a2a';

export interface TransportAvailability {
  mcp: boolean;
  acp: boolean;
  a2a: boolean;
}

export interface CapabilitySourceCount {
  source: CapabilitySource;
  count: number;
}

export interface RuntimeBootstrapReport {
  /** Agent the runtime is initialized for. */
  agentId: string;
  /** Timestamp when the report was generated. */
  generatedAt: number;
  /** Registered model provider names. */
  modelProviders: string[];
  /** Configured default provider. */
  defaultModelProvider: string;
  /** Total registered capabilities. */
  capabilityCount: number;
  /** Capability counts by source. */
  capabilitySources: CapabilitySourceCount[];
  /** Number of active policy rules. */
  activePolicyCount: number;
  /** Whether the approval manager is wired. */
  approvalManagerEnabled: boolean;
  /** Whether checkpointing is enabled. */
  checkpointManagerEnabled: boolean;
  /** Transcript store mode. */
  transcriptStoreMode: TranscriptStoreMode;
  /** Runtime transport availability. */
  transportAvailability: TransportAvailability;
  /** Veridex capability wiring summary. */
  veridex: {
    identityWired: boolean;
    paymentsWired: boolean;
    controlPlaneConnected: boolean | null;
  };
  /** Default runtime budgets and loop settings. */
  defaults: {
    maxTurns: number;
    maxTokenBudget?: number;
    contextTokenBudget: number;
    historyTurns: number;
  };
}
