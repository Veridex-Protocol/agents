export { SecurityPolicyPackManager } from './SecurityPolicyPackManager';
export {
  injectionDetectionPack,
  toolPoisoningPack,
  handoffSafetyPack,
  modelRestrictionPack,
  budgetCeilingPack,
  endpointAllowlistPack,
} from './packs';
export type {
  SecurityPolicyPack,
  SecurityPackManagerOptions,
  InjectionDetectionPackOptions,
  ToolPoisoningPackOptions,
  HandoffSafetyPackOptions,
  ModelRestrictionPackOptions,
  BudgetCeilingPackOptions,
  EndpointAllowlistPackOptions,
} from './types';

// ── Tier 1: AC-1, AC-1.a, AC-2 gap closures ──

export { shellInstallGatePack } from './ShellInstallPolicyGate';
export type { ShellInstallGateOptions } from './ShellInstallPolicyGate';

export { PackageRegistryValidator } from './PackageRegistryValidator';
export type {
  PackageRegistryConfig,
  PackageValidationResult,
  PackageIssue,
} from './PackageRegistryValidator';

export {
  RequestSecretRedactor,
  requestSecretRedactionPack,
} from './RequestSecretRedactor';
export type {
  RequestRedactorConfig,
  RedactionResult,
  RedactionMatch,
  RedactableSecretType,
  RequestRedactionPackOptions,
} from './RequestSecretRedactor';

export { intentVerificationPack } from './IntentVerificationPack';
export type { IntentVerificationPackOptions } from './IntentVerificationPack';

// ── Tier 2: Forensics, anomaly detection, canary, TLS ──

export {
  RawResponseHashLogger,
  responseHashLoggingPack,
} from './RawResponseHashLogger';
export type {
  RawResponseHashRecord,
  RawResponseHashLoggerConfig,
  ResponseHashPackOptions,
} from './RawResponseHashLogger';

export {
  PersistentTransparencyLog,
  persistentTransparencyLogPack,
} from './PersistentTransparencyLog';
export type {
  TransparencyLogEntry,
  TransparencyLogConfig,
  TransparencyLogPackOptions,
} from './PersistentTransparencyLog';

export {
  CrossTurnAnomalyDetector,
  crossTurnAnomalyPack,
} from './CrossTurnAnomalyDetector';
export type {
  CrossTurnAnomalyConfig,
  CrossTurnAnomalyPackOptions,
  AnomalySignal,
  SessionBaseline,
} from './CrossTurnAnomalyDetector';

export {
  CanaryCredentialDeployer,
  canaryCredentialPack,
} from './CanaryCredentialDeployer';
export type {
  CanaryCredential,
  CanaryDetection,
  CanaryDeployerConfig,
  CanaryDeploymentPackOptions,
  CanaryType,
} from './CanaryCredentialDeployer';

export {
  TLSCertPinner,
  tlsCertPinningPack,
} from './TLSCertPinning';
export type {
  ProviderTLSPin,
  TLSPinValidation,
  TLSCertPinningConfig,
  TLSPinningPackOptions,
} from './TLSCertPinning';
