import type { ExecutionSurfaceSummary } from '../types/execution';
import type { RuntimeBootstrapReport, TransportAvailability } from '../types/bootstrap';
import type { TranscriptStoreMode } from '../types/transcript';

export interface BuildRuntimeBootstrapReportInput {
  agentId: string;
  modelProviders: string[];
  defaultModelProvider: string;
  capabilitySummary: ExecutionSurfaceSummary;
  activePolicyCount: number;
  approvalManagerEnabled: boolean;
  checkpointManagerEnabled: boolean;
  transcriptStoreMode: TranscriptStoreMode;
  transportAvailability?: Partial<TransportAvailability>;
  identityWired: boolean;
  paymentsWired: boolean;
  controlPlaneConnected?: boolean | null;
  maxTurns: number;
  maxTokenBudget?: number;
  contextTokenBudget: number;
  historyTurns: number;
}

const DEFAULT_TRANSPORT_AVAILABILITY: TransportAvailability = {
  mcp: false,
  acp: false,
  a2a: false,
};

export function buildRuntimeBootstrapReport(
  input: BuildRuntimeBootstrapReportInput,
): RuntimeBootstrapReport {
  const transportAvailability: TransportAvailability = {
    ...DEFAULT_TRANSPORT_AVAILABILITY,
    ...input.transportAvailability,
  };

  return {
    agentId: input.agentId,
    generatedAt: Date.now(),
    modelProviders: [...input.modelProviders].sort(),
    defaultModelProvider: input.defaultModelProvider,
    capabilityCount: input.capabilitySummary.total,
    capabilitySources: Object.entries(input.capabilitySummary.bySource)
      .filter(([, count]) => count > 0)
      .map(([source, count]) => ({
        source: source as keyof ExecutionSurfaceSummary['bySource'],
        count,
      })),
    activePolicyCount: input.activePolicyCount,
    approvalManagerEnabled: input.approvalManagerEnabled,
    checkpointManagerEnabled: input.checkpointManagerEnabled,
    transcriptStoreMode: input.transcriptStoreMode,
    transportAvailability,
    veridex: {
      identityWired: input.identityWired,
      paymentsWired: input.paymentsWired,
      controlPlaneConnected: input.controlPlaneConnected ?? null,
    },
    defaults: {
      maxTurns: input.maxTurns,
      maxTokenBudget: input.maxTokenBudget,
      contextTokenBudget: input.contextTokenBudget,
      historyTurns: input.historyTurns,
    },
  };
}
