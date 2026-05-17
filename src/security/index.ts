/**
 * @packageDocumentation
 * @module @veridex/agents/security
 * @description
 * Runtime-native security packs that return `SecurityPolicyPack` shapes for
 * the {@link AgentRuntime}'s policy engine and hook runner.
 *
 * For **framework-agnostic** detection packs (cross-framework — LangChain,
 * CrewAI, custom agents) prefer the canonical home in
 * [`@veridex/agent-security`](../../agents-security). To bridge that gateway
 * into the runtime, use
 * {@link import('../integrations/SecurityGatewayPlugin').securityGatewayPlugin}.
 *
 * The two surfaces share detection intent (injection, tool poisoning, etc.)
 * but produce different output shapes (`PolicyRule`/`RuntimeHook` here vs
 * `SecurityPack` in the gateway). Full pattern-primitive unification is
 * tracked as a future refactor.
 */

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
