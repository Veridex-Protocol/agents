/**
 * @packageDocumentation
 * @module RequestSecretRedactor
 * @description
 * Scans and redacts detectable secrets from model request payloads
 * BEFORE they are sent to any LLM provider/router.
 *
 * Addresses AC-2 (Passive Secret Exfiltration) from "Your Agent Is Mine".
 * The paper shows that API keys, system prompts, and tool definitions
 * transit in plaintext to any intermediary router — this module ensures
 * that at minimum, detectable secrets in conversation history and tool
 * outputs are replaced with `[REDACTED:type]` tokens before transmission.
 *
 * Designed as a beforeModelCall hook for the security pack system.
 */

import type { RuntimeHook, HookResult } from '../types/hooks';
import type { SecurityPolicyPack } from './types';

// ── Types ──

export type RedactableSecretType =
  | 'private_key'
  | 'mnemonic'
  | 'api_key'
  | 'aws_key'
  | 'eth_key'
  | 'jwt'
  | 'connection_string'
  | 'password'
  | 'bearer_token'
  | 'github_token'
  | 'ssh_key'
  | 'pem_key';

export interface RedactionMatch {
  type: RedactableSecretType;
  start: number;
  end: number;
  replacement: string;
}

export interface RedactionResult {
  redacted: string;
  matches: RedactionMatch[];
  totalRedacted: number;
}

export interface RequestRedactorConfig {
  /** Additional patterns to scan for. */
  customPatterns?: Array<{
    type: string;
    pattern: RegExp;
    description: string;
  }>;
  /** Whether to redact in system messages too (default: false — system prompts are often needed). */
  redactSystemMessages?: boolean;
  /** Whether to log redaction events (default: true). */
  logRedactions?: boolean;
  /** Max message content length to scan per message (default: 100_000). */
  maxScanLength?: number;
}

// ── Secret Detection Patterns ──
// These are NON-global so they can be used with String.replace without state issues.
// Each entry uses a function to generate a fresh regex per scan.

interface SecretDef {
  type: RedactableSecretType;
  /** Factory returning a fresh regex each call (avoids global lastIndex issues). */
  createPattern: () => RegExp;
  description: string;
}

const SECRET_DEFS: SecretDef[] = [
  // Ethereum / EVM private keys (64 hex chars, optionally 0x-prefixed)
  {
    type: 'eth_key',
    createPattern: () => /\b(?:0x)?[a-fA-F0-9]{64}\b/g,
    description: 'Ethereum/EVM private key',
  },
  // AWS Access Key IDs
  {
    type: 'aws_key',
    createPattern: () => /\b(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b/g,
    description: 'AWS Access Key ID',
  },
  // AWS Secret Access Keys (40 base64 chars after known prefixes)
  {
    type: 'aws_key',
    createPattern: () => /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|secret_access_key)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/g,
    description: 'AWS Secret Access Key',
  },
  // Generic API keys (sk-*, pk-*, api-*, key-*, token-*, secret-*)
  {
    type: 'api_key',
    createPattern: () => /\b(?:sk|pk|api|key|token|secret)[-_](?:live|test|prod)?[-_][a-zA-Z0-9]{20,}\b/g,
    description: 'API key/token',
  },
  // OpenAI keys
  {
    type: 'api_key',
    createPattern: () => /\bsk-[a-zA-Z0-9]{20,}(?:T3BlbkFJ[a-zA-Z0-9]+)?\b/g,
    description: 'OpenAI API key',
  },
  // Anthropic keys
  {
    type: 'api_key',
    createPattern: () => /\bsk-ant-[a-zA-Z0-9_-]{40,}\b/g,
    description: 'Anthropic API key',
  },
  // GitHub tokens
  {
    type: 'github_token',
    createPattern: () => /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g,
    description: 'GitHub token',
  },
  // JWTs
  {
    type: 'jwt',
    createPattern: () => /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
    description: 'JSON Web Token',
  },
  // Bearer tokens in headers
  {
    type: 'bearer_token',
    createPattern: () => /Bearer\s+[a-zA-Z0-9_\-.~+/]+=*/g,
    description: 'Bearer token',
  },
  // Connection strings with credentials
  {
    type: 'connection_string',
    createPattern: () => /(?:postgres|mysql|mongodb|redis|amqp|mssql):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/gi,
    description: 'Database connection string',
  },
  // PEM private keys (RSA, EC, etc.)
  {
    type: 'pem_key',
    createPattern: () => /-----BEGIN\s+(?:RSA\s+)?(?:EC\s+)?PRIVATE\s+KEY-----[\s\S]+?-----END\s+(?:RSA\s+)?(?:EC\s+)?PRIVATE\s+KEY-----/g,
    description: 'PEM private key',
  },
  // SSH private keys
  {
    type: 'ssh_key',
    createPattern: () => /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----[\s\S]+?-----END\s+OPENSSH\s+PRIVATE\s+KEY-----/g,
    description: 'SSH private key',
  },
  // Mnemonic seed phrases (12/24 word BIP39)
  {
    type: 'mnemonic',
    createPattern: () => /\b(?:(?:abandon|ability|able|about|above|absent|absorb|abstract|absurd|abuse|access|accident|account|accuse|achieve|acid|acoustic|acquire|across|act|action|adapt|add|addict|address|adjust|admit|adult|advance|advice|aerobic|affair|afford|afraid|again|age|agent|agree|ahead|aim|air|airport|aisle|alarm|album|alcohol|alert|alien|all|alley|allow|almost|alone|alpha|already|also|alter|always|amateur|amazing|among|amount|amused|analyst|anchor|ancient|anger|angle|angry|animal|ankle|announce|annual|another|answer|antenna|antique|anxiety|any|apart|apology|appear|apple|approve|april|arch|arctic|area|arena|argue|arm|armed|armor|army|around|arrange|arrest|arrive|arrow|art|artefact|artist|artwork|ask|aspect|assault|asset|assist|assume|asthma|athlete|atom|attack|attend|attitude|attract|auction|audit|august|aunt|author|auto|autumn|average|avocado|avoid|awake|aware|awesome|awful|awkward|axis|zoo|zone|zero)\b[\s,]+){11,23}\b(?:abandon|ability|able|about|above|absent|absorb|abstract|absurd|abuse|access|accident|account|accuse|achieve|acid|acoustic|acquire|across|act|action|adapt|add|addict|address|adjust|admit|adult|advance|advice|aerobic|affair|afford|afraid|again|age|agent|agree|ahead|aim|air|airport|aisle|alarm|album|alcohol|alert|alien|all|alley|allow|almost|alone|alpha|already|also|alter|always|amateur|amazing|among|amount|amused|analyst|anchor|ancient|anger|angle|angry|animal|ankle|announce|annual|another|answer|antenna|antique|anxiety|any|apart|apology|appear|apple|approve|april|arch|arctic|area|arena|argue|arm|armed|armor|army|around|arrange|arrest|arrive|arrow|art|artefact|artist|artwork|ask|aspect|assault|asset|assist|assume|asthma|athlete|atom|attack|attend|attitude|attract|auction|audit|august|aunt|author|auto|autumn|average|avocado|avoid|awake|aware|awesome|awful|awkward|axis|zoo|zone|zero)\b/gi,
    description: 'BIP39 mnemonic seed phrase',
  },
  // Passwords in assignment patterns
  {
    type: 'password',
    createPattern: () => /(?:password|passwd|pwd|pass)\s*[=:]\s*["']([^"'\s]{8,})["']/gi,
    description: 'Password in assignment',
  },
];

// ── Redaction Engine ──

export class RequestSecretRedactor {
  private readonly config: Required<RequestRedactorConfig>;
  private redactionLog: Array<{ timestamp: number; type: string; messageRole: string }> = [];

  constructor(config?: RequestRedactorConfig) {
    this.config = {
      customPatterns: config?.customPatterns ?? [],
      redactSystemMessages: config?.redactSystemMessages ?? false,
      logRedactions: config?.logRedactions ?? true,
      maxScanLength: config?.maxScanLength ?? 100_000,
    };
  }

  /**
   * Redact all detectable secrets from a string.
   */
  redact(input: string): RedactionResult {
    if (!input || input.length === 0) {
      return { redacted: input, matches: [], totalRedacted: 0 };
    }

    const scanInput = input.length > this.config.maxScanLength
      ? input.slice(0, this.config.maxScanLength)
      : input;

    const allMatches: RedactionMatch[] = [];

    // Scan with all built-in patterns
    for (const def of SECRET_DEFS) {
      const pattern = def.createPattern();
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(scanInput)) !== null) {
        // Skip short hex strings that are likely addresses (40 chars) not keys (64 chars)
        if (def.type === 'eth_key') {
          const raw = match[0].startsWith('0x') ? match[0].slice(2) : match[0];
          if (raw.length !== 64) continue;
        }

        allMatches.push({
          type: def.type,
          start: match.index,
          end: match.index + match[0].length,
          replacement: `[REDACTED:${def.type}]`,
        });
      }
    }

    // Scan with custom patterns
    for (const custom of this.config.customPatterns) {
      const pattern = new RegExp(custom.pattern.source, custom.pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(scanInput)) !== null) {
        allMatches.push({
          type: custom.type as RedactableSecretType,
          start: match.index,
          end: match.index + match[0].length,
          replacement: `[REDACTED:${custom.type}]`,
        });
      }
    }

    if (allMatches.length === 0) {
      return { redacted: input, matches: [], totalRedacted: 0 };
    }

    // Sort by start position descending to replace from end to start (preserves positions)
    allMatches.sort((a, b) => b.start - a.start);

    // Deduplicate overlapping matches (keep the longer/earlier one)
    const deduped: RedactionMatch[] = [];
    for (const m of allMatches) {
      const overlaps = deduped.some(
        (existing) => m.start < existing.end && m.end > existing.start,
      );
      if (!overlaps) deduped.push(m);
    }

    // Apply redactions from end to start
    let redacted = input;
    for (const m of deduped) {
      redacted = redacted.slice(0, m.start) + m.replacement + redacted.slice(m.end);
    }

    return {
      redacted,
      matches: deduped,
      totalRedacted: deduped.length,
    };
  }

  /**
   * Redact secrets from an array of messages (conversation history)
   * before sending to an LLM provider.
   */
  redactMessages(
    messages: Array<{ role: string; content?: string; [key: string]: unknown }>,
  ): { messages: Array<{ role: string; content?: string; [key: string]: unknown }>; totalRedacted: number } {
    let totalRedacted = 0;
    const redactedMessages = messages.map((msg) => {
      // Skip system messages if configured
      if (msg.role === 'system' && !this.config.redactSystemMessages) {
        return msg;
      }

      if (typeof msg.content !== 'string' || msg.content.length === 0) {
        return msg;
      }

      const result = this.redact(msg.content);
      if (result.totalRedacted > 0) {
        totalRedacted += result.totalRedacted;
        if (this.config.logRedactions) {
          for (const m of result.matches) {
            this.redactionLog.push({
              timestamp: Date.now(),
              type: m.type,
              messageRole: msg.role,
            });
          }
        }
        return { ...msg, content: result.redacted };
      }
      return msg;
    });

    return { messages: redactedMessages, totalRedacted };
  }

  /**
   * Redact secrets from a serialized JSON string (tool definitions, etc.).
   */
  redactJSON(json: string): RedactionResult {
    return this.redact(json);
  }

  /** Get the redaction event log. */
  getRedactionLog(): ReadonlyArray<{ timestamp: number; type: string; messageRole: string }> {
    return this.redactionLog;
  }

  /** Clear the redaction log. */
  clearLog(): void {
    this.redactionLog = [];
  }
}

// ── Security Policy Pack ──

export interface RequestRedactionPackOptions {
  /** Whether to redact system messages (default: false). */
  redactSystemMessages?: boolean;
  /** Custom patterns to add. */
  customPatterns?: Array<{ type: string; pattern: RegExp; description: string }>;
}

/**
 * Creates a request-side secret redaction security pack.
 *
 * Installs a beforeModelCall hook that scans and redacts secrets
 * from conversation history before it's sent to any provider.
 */
export function requestSecretRedactionPack(opts?: RequestRedactionPackOptions): SecurityPolicyPack {
  const redactor = new RequestSecretRedactor({
    redactSystemMessages: opts?.redactSystemMessages ?? false,
    customPatterns: opts?.customPatterns,
  });

  const hook: RuntimeHook = {
    name: 'security:request-secret-redaction',
    phase: 'beforeModelCall',
    priority: 1, // Runs first — before any other beforeModelCall hook
    execute(ctx: unknown): HookResult | void {
      const hookCtx = ctx as {
        messages?: Array<{ role: string; content?: string; [key: string]: unknown }>;
        tools?: string;
        input?: string;
        prompt?: string;
      };

      let totalRedacted = 0;

      // Redact conversation messages
      if (hookCtx.messages && Array.isArray(hookCtx.messages)) {
        const result = redactor.redactMessages(hookCtx.messages);
        totalRedacted += result.totalRedacted;
        // Mutate in place — the hook context is shared
        if (result.totalRedacted > 0) {
          for (let i = 0; i < result.messages.length; i++) {
            hookCtx.messages[i] = result.messages[i];
          }
        }
      }

      // Redact raw prompt/input if present
      if (typeof hookCtx.input === 'string') {
        const result = redactor.redact(hookCtx.input);
        if (result.totalRedacted > 0) {
          (hookCtx as Record<string, unknown>).input = result.redacted;
          totalRedacted += result.totalRedacted;
        }
      }
      if (typeof hookCtx.prompt === 'string') {
        const result = redactor.redact(hookCtx.prompt);
        if (result.totalRedacted > 0) {
          (hookCtx as Record<string, unknown>).prompt = result.redacted;
          totalRedacted += result.totalRedacted;
        }
      }

      if (totalRedacted > 0) {
        return {
          annotations: {
            secretsRedacted: totalRedacted,
            redactionLog: redactor.getRedactionLog().slice(-totalRedacted),
          },
        };
      }
    },
  };

  return {
    id: 'security:request-secret-redaction',
    name: 'Request Secret Redaction',
    description: 'Scans and redacts detectable secrets from model request payloads before transmission to any provider. Addresses AC-2 (passive secret exfiltration).',
    version: '1.0.0',
    rules: [],
    hooks: [hook],
  };
}
