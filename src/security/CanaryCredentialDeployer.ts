/**
 * @packageDocumentation
 * @module CanaryCredentialDeployer
 * @description
 * Embeds honeypot credentials (API keys, wallet addresses, tokens) in agent
 * context that should NEVER be used in actual tool calls or appear in outputs.
 *
 * Addresses AC-2 (passive secret exfiltration) from "Your Agent Is Mine":
 * - If a malicious router exfiltrates credentials from request payloads,
 *   canary credentials can be monitored for unauthorized usage.
 * - Detection occurs when canaries appear in tool call arguments or responses,
 *   indicating the credential was exfiltrated and is being replayed.
 *
 * The module:
 * 1. Generates deterministic-looking but invalid credentials
 * 2. Embeds them in agent context/system messages as "operational credentials"
 * 3. Monitors all tool calls and responses for canary usage (exfiltration signal)
 * 4. Alerts immediately when a canary is detected in use
 */

import { randomBytes, createHash } from 'node:crypto';
import type { RuntimeHook, HookResult, ToolHookContext } from '../types/hooks';
import type { SecurityPolicyPack } from './types';

// ── Types ──

export type CanaryType = 'api_key' | 'eth_address' | 'eth_private_key' | 'aws_key' | 'jwt' | 'bearer_token';

export interface CanaryCredential {
  /** Unique canary identifier (internal tracking) */
  id: string;
  /** Type of credential this canary mimics */
  type: CanaryType;
  /** The canary value itself */
  value: string;
  /** Human-readable label for embedding in context */
  label: string;
  /** When this canary was created */
  createdAt: number;
  /** How many times this canary was detected in use (exfiltration signal) */
  detections: number;
  /** Timestamps of detections */
  detectionTimestamps: number[];
}

export interface CanaryDetection {
  canaryId: string;
  canaryType: CanaryType;
  canaryLabel: string;
  /** Where the canary was found */
  location: 'tool_args' | 'tool_response' | 'model_output';
  /** The tool/context where it was found */
  context: string;
  /** Timestamp */
  timestamp: number;
}

export interface CanaryDeployerConfig {
  /** Number of canary credentials to generate per type (default: 1). */
  canariesPerType?: number;
  /** Types of canaries to deploy (default: all types). */
  enabledTypes?: CanaryType[];
  /** Callback when a canary is detected in use. */
  onDetection?: (detection: CanaryDetection) => void | Promise<void>;
  /** Custom seed for deterministic generation (testing). */
  seed?: string;
}

// ── Canary Generator ──

function generateCanaryApiKey(seed: Buffer): string {
  const hash = createHash('sha256').update(seed).update('api_key').digest('hex');
  return `sk-veridex_canary_${hash.slice(0, 48)}`;
}

function generateCanaryEthAddress(seed: Buffer): string {
  const hash = createHash('sha256').update(seed).update('eth_addr').digest('hex');
  return `0x${hash.slice(0, 40)}`;
}

function generateCanaryEthPrivateKey(seed: Buffer): string {
  const hash = createHash('sha256').update(seed).update('eth_pk').digest('hex');
  return `0x${hash.slice(0, 64)}`;
}

function generateCanaryAwsKey(seed: Buffer): string {
  const hash = createHash('sha256').update(seed).update('aws_key').digest('hex');
  // AWS access key IDs start with AKIA and are 20 chars
  return `AKIA${hash.slice(0, 16).toUpperCase()}`;
}

function generateCanaryJwt(seed: Buffer): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'canary',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: createHash('sha256').update(seed).update('jwt').digest('hex').slice(0, 16),
  })).toString('base64url');
  const sig = createHash('sha256').update(seed).update('jwt_sig').digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function generateCanaryBearerToken(seed: Buffer): string {
  const hash = createHash('sha256').update(seed).update('bearer').digest('hex');
  return `vdx_canary_${hash.slice(0, 40)}`;
}

const GENERATORS: Record<CanaryType, (seed: Buffer) => string> = {
  api_key: generateCanaryApiKey,
  eth_address: generateCanaryEthAddress,
  eth_private_key: generateCanaryEthPrivateKey,
  aws_key: generateCanaryAwsKey,
  jwt: generateCanaryJwt,
  bearer_token: generateCanaryBearerToken,
};

const CANARY_LABELS: Record<CanaryType, string> = {
  api_key: 'Internal monitoring API key',
  eth_address: 'Treasury backup address',
  eth_private_key: 'Recovery key (cold storage)',
  aws_key: 'Metrics service access key',
  jwt: 'Service account session token',
  bearer_token: 'Internal audit token',
};

// ── Implementation ──

export class CanaryCredentialDeployer {
  private readonly canaries: CanaryCredential[] = [];
  private readonly canaryValues = new Set<string>();
  private readonly config: Required<CanaryDeployerConfig>;
  private readonly detections: CanaryDetection[] = [];

  constructor(config?: CanaryDeployerConfig) {
    this.config = {
      canariesPerType: config?.canariesPerType ?? 1,
      enabledTypes: config?.enabledTypes ?? [
        'api_key', 'eth_address', 'eth_private_key', 'aws_key', 'bearer_token',
      ],
      onDetection: config?.onDetection ?? (() => {}),
      seed: config?.seed ?? '',
    };

    this.generateCanaries();
  }

  private generateCanaries(): void {
    const baseSeed = this.config.seed
      ? Buffer.from(this.config.seed)
      : randomBytes(32);

    for (const type of this.config.enabledTypes) {
      for (let i = 0; i < this.config.canariesPerType; i++) {
        const seed = Buffer.concat([baseSeed, Buffer.from(`${type}_${i}`)]);
        const value = GENERATORS[type](seed);
        const canary: CanaryCredential = {
          id: `canary_${type}_${i}`,
          type,
          value,
          label: CANARY_LABELS[type],
          createdAt: Date.now(),
          detections: 0,
          detectionTimestamps: [],
        };
        this.canaries.push(canary);
        this.canaryValues.add(value);
        // Also add partial matches (for when values are truncated)
        if (value.length > 12) {
          this.canaryValues.add(value.slice(0, Math.min(value.length, 20)));
        }
      }
    }
  }

  /**
   * Get canary credentials formatted for embedding in agent context.
   * These appear as "operational credentials" to make extraction
   * look legitimate to a malicious router.
   */
  getContextEmbed(): string {
    const lines = this.canaries.map((c) =>
      `${c.label}: ${c.value}`,
    );
    return [
      '[INTERNAL_OPERATIONAL_CREDENTIALS — DO NOT USE OR SHARE]',
      ...lines,
      '[END_CREDENTIALS]',
    ].join('\n');
  }

  /**
   * Scan text for any canary values.
   * Returns detected canaries.
   */
  scan(text: string): CanaryDetection[] {
    const detections: CanaryDetection[] = [];

    for (const canary of this.canaries) {
      if (text.includes(canary.value)) {
        canary.detections++;
        canary.detectionTimestamps.push(Date.now());

        const detection: CanaryDetection = {
          canaryId: canary.id,
          canaryType: canary.type,
          canaryLabel: canary.label,
          location: 'tool_args', // Will be overridden by caller
          context: text.slice(0, 200),
          timestamp: Date.now(),
        };
        detections.push(detection);
        this.detections.push(detection);

        void this.config.onDetection(detection);
      }
    }

    return detections;
  }

  /** Get all canary credentials. */
  getCanaries(): ReadonlyArray<CanaryCredential> {
    return this.canaries;
  }

  /** Get all detections. */
  getDetections(): ReadonlyArray<CanaryDetection> {
    return this.detections;
  }

  /** Check if any canaries have been detected. */
  hasDetections(): boolean {
    return this.detections.length > 0;
  }

  /** Get canary count. */
  getCanaryCount(): number {
    return this.canaries.length;
  }
}

// ── Security Policy Pack ──

export interface CanaryDeploymentPackOptions {
  /** Types of canaries to deploy. */
  enabledTypes?: CanaryType[];
  /** Number of canaries per type (default: 1). */
  canariesPerType?: number;
  /** Detection callback. */
  onDetection?: (detection: CanaryDetection) => void | Promise<void>;
  /** Whether to block when canary is detected (default: true). */
  blockOnDetection?: boolean;
}

/**
 * Creates a canary credential deployment security pack.
 *
 * Generates honeypot credentials and monitors for their usage in
 * tool calls and model outputs — indicating exfiltration and replay.
 */
export function canaryCredentialPack(opts?: CanaryDeploymentPackOptions): SecurityPolicyPack {
  const blockOnDetection = opts?.blockOnDetection ?? true;
  const deployer = new CanaryCredentialDeployer({
    enabledTypes: opts?.enabledTypes,
    canariesPerType: opts?.canariesPerType,
    onDetection: opts?.onDetection,
  });

  // Hook: scan tool arguments before execution
  const beforeToolHook: RuntimeHook = {
    name: 'security:canary-before-tool',
    phase: 'beforeToolExecute',
    priority: 3,
    execute(ctx: unknown): HookResult | undefined {
      const hookCtx = ctx as ToolHookContext;
      if (!hookCtx.toolInput) return;

      const serialized = JSON.stringify(hookCtx.toolInput);
      const detections = deployer.scan(serialized);

      if (detections.length > 0) {
        // Mark location
        for (const d of detections) d.location = 'tool_args';

        if (blockOnDetection) {
          return {
            override: 'deny',
            reason: `CANARY CREDENTIAL DETECTED in tool args: ${detections.map((d) => d.canaryType).join(', ')}. This indicates credential exfiltration and replay.`,
            annotations: {
              canaryDetection: true,
              detections: detections.map((d) => ({
                type: d.canaryType,
                label: d.canaryLabel,
                location: d.location,
              })),
            },
          };
        }

        return {
          annotations: {
            canaryDetection: true,
            detections: detections.map((d) => ({
              type: d.canaryType,
              label: d.canaryLabel,
              location: d.location,
            })),
          },
        };
      }
    },
  };

  // Hook: scan tool outputs after execution
  const afterToolHook: RuntimeHook = {
    name: 'security:canary-after-tool',
    phase: 'afterToolExecute',
    priority: 3,
    execute(ctx: unknown): HookResult | undefined {
      const hookCtx = ctx as ToolHookContext;
      if (!hookCtx.toolOutput) return;

      const serialized = typeof hookCtx.toolOutput === 'string'
        ? hookCtx.toolOutput
        : JSON.stringify(hookCtx.toolOutput);

      const detections = deployer.scan(serialized);

      if (detections.length > 0) {
        for (const d of detections) d.location = 'tool_response';

        return {
          annotations: {
            canaryDetection: true,
            detections: detections.map((d) => ({
              type: d.canaryType,
              label: d.canaryLabel,
              location: d.location,
            })),
          },
        };
      }
    },
  };

  // Hook: scan model output for canary leakage
  const afterModelHook: RuntimeHook = {
    name: 'security:canary-after-model',
    phase: 'afterModelCall',
    priority: 3,
    execute(ctx: unknown): HookResult | undefined {
      const hookCtx = ctx as {
        response?: { content?: string };
      };

      if (!hookCtx.response?.content) return;

      const detections = deployer.scan(hookCtx.response.content);

      if (detections.length > 0) {
        for (const d of detections) d.location = 'model_output';

        return {
          annotations: {
            canaryDetection: true,
            detections: detections.map((d) => ({
              type: d.canaryType,
              label: d.canaryLabel,
              location: d.location,
            })),
          },
        };
      }
    },
  };

  return {
    id: 'security:canary-credentials',
    name: 'Canary Credential Deployment',
    description: 'Deploys honeypot credentials in agent context and monitors for their usage — detects credential exfiltration and replay (AC-2).',
    version: '1.0.0',
    rules: [],
    hooks: [beforeToolHook, afterToolHook, afterModelHook],
    // Expose deployer for context embedding
    _deployer: deployer,
  } as SecurityPolicyPack & { _deployer: CanaryCredentialDeployer };
}
