export { AuditEmitter, InMemoryAuditSink } from './AuditEmitter';
export type {
  AuditBundle,
  ToolExecutionSummary,
  AuditExportFormat,
  AuditSink,
} from './AuditEmitter';

// ── Unified Trace Envelope ──
export { TraceEnvelopeBuilder } from './TraceEnvelopeBuilder';
export { UnifiedTraceCollector, InMemoryEnvelopeSink } from './UnifiedTraceCollector';
export type { EnvelopeSink, UnifiedTraceCollectorOptions } from './UnifiedTraceCollector';
export type {
  TraceEnvelope,
  TraceEnvelopeBuildParams,
  ReasoningSnapshot,
  EnvelopeStorageReceipt,
  EnvelopeSettlementProof,
  EnvelopeVerificationResult,
} from './types';
