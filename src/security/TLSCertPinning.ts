/**
 * @packageDocumentation
 * @module TLSCertPinning
 * @description
 * TLS certificate pinning for direct connections to known LLM providers.
 * Pins the SHA-256 fingerprints of provider TLS certificates to prevent
 * silent redirect or MITM attacks on model API calls.
 *
 * Addresses AC-1 (payload injection) and AC-2 (secret exfiltration):
 * - When the agent runtime makes direct calls to providers (not via a router),
 *   pinning prevents silent redirect to a malicious endpoint.
 * - Does NOT help when a router is explicitly configured (the user chose
 *   to trust the router), but prevents accidental misrouting.
 *
 * Operates as a beforeModelCall hook that validates the resolved endpoint
 * against known-good TLS certificates for each provider.
 */

import { createHash } from 'crypto';
import type { RuntimeHook, HookResult } from '../types/hooks';
import type { SecurityPolicyPack } from './types';

// ── Types ──

export interface ProviderTLSPin {
  /** Provider identifier (e.g., 'openai', 'anthropic', 'google'). */
  provider: string;
  /** Known-good hostnames for this provider. */
  hostnames: string[];
  /** SHA-256 fingerprints of known-good certificates (any one match is ok). */
  certFingerprints: string[];
  /** Whether to block or warn on pin mismatch (default: 'warn'). */
  onMismatch?: 'block' | 'warn';
}

export interface TLSPinValidation {
  provider: string;
  hostname: string;
  valid: boolean;
  reason: string;
  fingerprint?: string;
}

export interface TLSCertPinningConfig {
  /** Additional provider pins beyond the built-in defaults. */
  additionalPins?: ProviderTLSPin[];
  /** Override built-in pins entirely. */
  overridePins?: ProviderTLSPin[];
  /** Default action on pin mismatch: 'block' or 'warn' (default: 'warn'). */
  defaultOnMismatch?: 'block' | 'warn';
  /** Whether to validate hostnames against known providers (default: true). */
  validateHostnames?: boolean;
  /** Whether to skip pinning for explicitly configured router endpoints (default: true). */
  skipForRouters?: boolean;
  /** Known router hostnames to skip (in addition to auto-detection). */
  knownRouterHostnames?: string[];
}

// ── Built-in Provider Pins ──
//
// NOTE: These fingerprints need to be updated when providers rotate certs.
// The structure is designed to hold multiple fingerprints per provider
// to support rotation without downtime.
//
// In production, these would be fetched from a trusted configuration
// service. For initial deployment, hostname validation alone provides
// meaningful protection against redirect attacks.

const BUILT_IN_PROVIDER_PINS: ProviderTLSPin[] = [
  {
    provider: 'openai',
    hostnames: [
      'api.openai.com',
    ],
    certFingerprints: [], // Populated at deploy time or via config
    onMismatch: 'warn',
  },
  {
    provider: 'anthropic',
    hostnames: [
      'api.anthropic.com',
    ],
    certFingerprints: [],
    onMismatch: 'warn',
  },
  {
    provider: 'google',
    hostnames: [
      'generativelanguage.googleapis.com',
      'aiplatform.googleapis.com',
    ],
    certFingerprints: [],
    onMismatch: 'warn',
  },
  {
    provider: 'mistral',
    hostnames: [
      'api.mistral.ai',
    ],
    certFingerprints: [],
    onMismatch: 'warn',
  },
  {
    provider: 'groq',
    hostnames: [
      'api.groq.com',
    ],
    certFingerprints: [],
    onMismatch: 'warn',
  },
  {
    provider: 'together',
    hostnames: [
      'api.together.xyz',
    ],
    certFingerprints: [],
    onMismatch: 'warn',
  },
  {
    provider: 'fireworks',
    hostnames: [
      'api.fireworks.ai',
    ],
    certFingerprints: [],
    onMismatch: 'warn',
  },
];

// Known router / gateway hostnames
const KNOWN_ROUTER_HOSTNAMES = new Set([
  'openrouter.ai',
  'api.openrouter.ai',
  'litellm.ai',
  'api.portkey.ai',
  'gateway.ai.cloudflare.com',
  'helicone.ai',
  'api.helicone.ai',
  'braintrust.ai',
  'api.braintrust.dev',
]);

// ── Implementation ──

export class TLSCertPinner {
  private readonly pins: Map<string, ProviderTLSPin>;
  private readonly hostnameToProvider: Map<string, string>;
  private readonly config: Required<TLSCertPinningConfig>;
  private readonly routerHostnames: Set<string>;

  constructor(config?: TLSCertPinningConfig) {
    this.config = {
      additionalPins: config?.additionalPins ?? [],
      overridePins: config?.overridePins ?? [],
      defaultOnMismatch: config?.defaultOnMismatch ?? 'warn',
      validateHostnames: config?.validateHostnames ?? true,
      skipForRouters: config?.skipForRouters ?? true,
      knownRouterHostnames: config?.knownRouterHostnames ?? [],
    };

    // Build pin map
    this.pins = new Map();
    this.hostnameToProvider = new Map();

    const allPins = this.config.overridePins.length > 0
      ? this.config.overridePins
      : [...BUILT_IN_PROVIDER_PINS, ...this.config.additionalPins];

    for (const pin of allPins) {
      this.pins.set(pin.provider.toLowerCase(), pin);
      for (const hostname of pin.hostnames) {
        this.hostnameToProvider.set(hostname.toLowerCase(), pin.provider.toLowerCase());
      }
    }

    // Build router hostname set
    this.routerHostnames = new Set([
      ...KNOWN_ROUTER_HOSTNAMES,
      ...this.config.knownRouterHostnames.map((h) => h.toLowerCase()),
    ]);
  }

  /**
   * Extract hostname from a URL or endpoint string.
   */
  static extractHostname(endpoint: string): string | null {
    try {
      const url = new URL(endpoint);
      return url.hostname.toLowerCase();
    } catch {
      // Try as bare hostname
      const match = endpoint.match(/^(?:https?:\/\/)?([^/:]+)/);
      return match ? match[1].toLowerCase() : null;
    }
  }

  /**
   * Compute SHA-256 fingerprint of a DER-encoded certificate.
   */
  static computeFingerprint(certDer: Buffer): string {
    return createHash('sha256').update(certDer).digest('hex');
  }

  /**
   * Validate an endpoint against known provider pins.
   */
  validate(endpoint: string, certFingerprint?: string): TLSPinValidation {
    const hostname = TLSCertPinner.extractHostname(endpoint);
    if (!hostname) {
      return {
        provider: 'unknown',
        hostname: endpoint,
        valid: false,
        reason: 'Could not extract hostname from endpoint',
      };
    }

    // Skip known routers
    if (this.config.skipForRouters && this.routerHostnames.has(hostname)) {
      return {
        provider: 'router',
        hostname,
        valid: true,
        reason: `Known router endpoint — pinning skipped (${hostname})`,
      };
    }

    // Find provider by hostname
    const provider = this.hostnameToProvider.get(hostname);
    if (!provider) {
      // Unknown endpoint — hostname validation
      if (this.config.validateHostnames) {
        return {
          provider: 'unknown',
          hostname,
          valid: false,
          reason: `Hostname '${hostname}' is not a known LLM provider endpoint`,
        };
      }
      return {
        provider: 'unknown',
        hostname,
        valid: true,
        reason: 'Hostname validation disabled — endpoint not checked',
      };
    }

    const pin = this.pins.get(provider);
    if (!pin) {
      return {
        provider,
        hostname,
        valid: true,
        reason: `No pin configured for provider '${provider}'`,
      };
    }

    // Hostname matches — now check cert fingerprint if available
    if (certFingerprint && pin.certFingerprints.length > 0) {
      const normalizedFP = certFingerprint.toLowerCase().replace(/[:\s]/g, '');
      const match = pin.certFingerprints.some(
        (fp) => fp.toLowerCase().replace(/[:\s]/g, '') === normalizedFP,
      );

      if (!match) {
        return {
          provider,
          hostname,
          valid: false,
          reason: `TLS certificate fingerprint mismatch for ${provider} (${hostname}). Expected one of: ${pin.certFingerprints.map((f) => f.slice(0, 16) + '...').join(', ')}`,
          fingerprint: normalizedFP,
        };
      }

      return {
        provider,
        hostname,
        valid: true,
        reason: `TLS certificate pin verified for ${provider}`,
        fingerprint: normalizedFP,
      };
    }

    // No cert fingerprint but hostname matches known provider
    return {
      provider,
      hostname,
      valid: true,
      reason: `Hostname verified for ${provider} (cert pinning available when fingerprints are configured)`,
    };
  }

  /** Get all configured provider pins. */
  getPins(): ReadonlyArray<ProviderTLSPin> {
    return [...this.pins.values()];
  }

  /** Check if a hostname is a known router. */
  isKnownRouter(hostname: string): boolean {
    return this.routerHostnames.has(hostname.toLowerCase());
  }
}

// ── Security Policy Pack ──

export interface TLSPinningPackOptions {
  /** Additional provider pins. */
  additionalPins?: ProviderTLSPin[];
  /** Default action on mismatch: 'block' or 'warn' (default: 'warn'). */
  defaultOnMismatch?: 'block' | 'warn';
  /** Whether to validate hostnames (default: true). */
  validateHostnames?: boolean;
  /** Known router hostnames to skip. */
  knownRouterHostnames?: string[];
}

/**
 * Creates a TLS certificate pinning security pack.
 *
 * Validates model provider endpoints against known-good hostnames
 * and optionally certificate fingerprints before model calls.
 */
export function tlsCertPinningPack(opts?: TLSPinningPackOptions): SecurityPolicyPack {
  const pinner = new TLSCertPinner({
    additionalPins: opts?.additionalPins,
    defaultOnMismatch: opts?.defaultOnMismatch ?? 'warn',
    validateHostnames: opts?.validateHostnames ?? true,
    knownRouterHostnames: opts?.knownRouterHostnames,
  });

  const defaultAction = opts?.defaultOnMismatch ?? 'warn';

  const hook: RuntimeHook = {
    name: 'security:tls-cert-pinning',
    phase: 'beforeModelCall',
    priority: 2, // After request secret redaction (priority 1)
    execute(ctx: unknown): HookResult | void {
      const hookCtx = ctx as {
        provider?: string;
        model?: string;
        endpoint?: string;
        tlsCertFingerprint?: string;
      };

      if (!hookCtx.endpoint && !hookCtx.provider) return;

      // Try to derive endpoint from provider if not explicitly set
      const endpoint = hookCtx.endpoint
        ?? (hookCtx.provider ? `https://api.${hookCtx.provider}.com` : undefined);

      if (!endpoint) return;

      const validation = pinner.validate(endpoint, hookCtx.tlsCertFingerprint);

      if (!validation.valid) {
        if (defaultAction === 'block') {
          return {
            override: 'deny',
            reason: `TLS pin validation failed: ${validation.reason}`,
            annotations: {
              tlsPinning: true,
              provider: validation.provider,
              hostname: validation.hostname,
              valid: false,
              reason: validation.reason,
            },
          };
        }

        // Warn mode — annotate but don't block
        return {
          annotations: {
            tlsPinning: true,
            provider: validation.provider,
            hostname: validation.hostname,
            valid: false,
            warning: validation.reason,
          },
        };
      }

      // Valid — annotate for transparency
      return {
        annotations: {
          tlsPinning: true,
          provider: validation.provider,
          hostname: validation.hostname,
          valid: true,
        },
      };
    },
  };

  return {
    id: 'security:tls-cert-pinning',
    name: 'TLS Certificate Pinning',
    description: 'Validates LLM provider endpoints against known-good hostnames and certificate fingerprints. Prevents silent redirect attacks. Addresses AC-1 and AC-2.',
    version: '1.0.0',
    rules: [],
    hooks: [hook],
  };
}
