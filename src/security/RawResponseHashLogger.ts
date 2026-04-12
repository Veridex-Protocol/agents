/**
 * @packageDocumentation
 * @module RawResponseHashLogger
 * @description
 * Hashes raw HTTP response bytes from LLM providers BEFORE any parsing,
 * and stores them alongside model call records for forensic comparison.
 *
 * Addresses AC-1 forensics from "Your Agent Is Mine" (§7.3):
 * - If a provider later offers response signing, these pre-computed hashes
 *   enable post-incident comparison.
 * - Detects response tampering by comparing hashes across identical requests.
 *
 * Integrates as an afterModelCall hook in the security pack system.
 */

import { createHash } from 'crypto';
import type { RuntimeHook, HookResult } from '../types/hooks';
import type { SecurityPolicyPack } from './types';

// ── Types ──

export interface RawResponseHashRecord {
  /** Unique record ID */
  id: string;
  /** SHA-256 hash of raw response body bytes */
  responseBodyHash: string;
  /** SHA-256 hash of the request body sent to provider */
  requestBodyHash?: string;
  /** Provider identifier (e.g., 'openai', 'anthropic') */
  provider: string;
  /** Model identifier */
  model: string;
  /** Provider endpoint / router URL (if available) */
  endpoint?: string;
  /** TLS certificate fingerprint of the responding server (if available) */
  tlsCertFingerprint?: string;
  /** Timestamp of the response */
  timestamp: number;
  /** Run ID */
  runId: string;
  /** Agent ID */
  agentId: string;
  /** Turn index */
  turnIndex: number;
  /** Content length in bytes */
  contentLength: number;
  /** Response status code if available */
  httpStatus?: number;
  /** Finish reason from model */
  finishReason?: string;
}

export interface RawResponseHashLoggerConfig {
  /** Whether to also hash the request body (default: true). */
  hashRequests?: boolean;
  /** Maximum records to retain in memory (default: 10000). */
  maxInMemoryRecords?: number;
  /** Callback for persisting records externally (optional). */
  onRecord?: (record: RawResponseHashRecord) => void | Promise<void>;
}

// ── Implementation ──

let hashRecordCounter = 0;

export class RawResponseHashLogger {
  private readonly records: RawResponseHashRecord[] = [];
  private readonly config: Required<RawResponseHashLoggerConfig>;

  constructor(config?: RawResponseHashLoggerConfig) {
    this.config = {
      hashRequests: config?.hashRequests ?? true,
      maxInMemoryRecords: config?.maxInMemoryRecords ?? 10_000,
      onRecord: config?.onRecord ?? (() => {}),
    };
  }

  /**
   * Compute SHA-256 hash of raw content.
   */
  static hashContent(content: string | Buffer): string {
    const hash = createHash('sha256');
    hash.update(typeof content === 'string' ? content : content);
    return hash.digest('hex');
  }

  /**
   * Record a raw response hash.
   */
  record(params: {
    responseBody: string;
    requestBody?: string;
    provider: string;
    model: string;
    endpoint?: string;
    tlsCertFingerprint?: string;
    runId: string;
    agentId: string;
    turnIndex: number;
    httpStatus?: number;
    finishReason?: string;
  }): RawResponseHashRecord {
    hashRecordCounter++;
    const record: RawResponseHashRecord = {
      id: `rrhash_${Date.now()}_${hashRecordCounter}`,
      responseBodyHash: RawResponseHashLogger.hashContent(params.responseBody),
      requestBodyHash: this.config.hashRequests && params.requestBody
        ? RawResponseHashLogger.hashContent(params.requestBody)
        : undefined,
      provider: params.provider,
      model: params.model,
      endpoint: params.endpoint,
      tlsCertFingerprint: params.tlsCertFingerprint,
      timestamp: Date.now(),
      runId: params.runId,
      agentId: params.agentId,
      turnIndex: params.turnIndex,
      contentLength: params.responseBody.length,
      httpStatus: params.httpStatus,
      finishReason: params.finishReason,
    };

    this.records.push(record);
    // Evict oldest if over capacity
    while (this.records.length > this.config.maxInMemoryRecords) {
      this.records.shift();
    }

    // Invoke external persistence callback
    void this.config.onRecord(record);

    return record;
  }

  /** Get all in-memory records. */
  getRecords(): ReadonlyArray<RawResponseHashRecord> {
    return this.records;
  }

  /** Get records for a specific run. */
  getByRun(runId: string): RawResponseHashRecord[] {
    return this.records.filter((r) => r.runId === runId);
  }

  /** Get records for a specific provider. */
  getByProvider(provider: string): RawResponseHashRecord[] {
    return this.records.filter((r) => r.provider === provider);
  }

  /** Compare two response hashes — returns true if they match. */
  static compareHashes(hash1: string, hash2: string): boolean {
    if (hash1.length !== hash2.length) return false;
    // Constant-time comparison
    let result = 0;
    for (let i = 0; i < hash1.length; i++) {
      result |= hash1.charCodeAt(i) ^ hash2.charCodeAt(i);
    }
    return result === 0;
  }

  /** Clear all in-memory records. */
  clear(): void {
    this.records.length = 0;
  }
}

// ── Security Policy Pack ──

export interface ResponseHashPackOptions {
  /** Whether to also hash request bodies (default: true). */
  hashRequests?: boolean;
  /** Max in-memory records (default: 10000). */
  maxRecords?: number;
  /** External persistence callback. */
  onRecord?: (record: RawResponseHashRecord) => void | Promise<void>;
}

/**
 * Creates a raw response hash logging security pack.
 *
 * Installs an afterModelCall hook that computes and stores SHA-256
 * hashes of raw LLM response bodies before any parsing.
 */
export function responseHashLoggingPack(opts?: ResponseHashPackOptions): SecurityPolicyPack {
  const logger = new RawResponseHashLogger({
    hashRequests: opts?.hashRequests ?? true,
    maxInMemoryRecords: opts?.maxRecords ?? 10_000,
    onRecord: opts?.onRecord,
  });

  const hook: RuntimeHook = {
    name: 'security:response-hash-logging',
    phase: 'afterModelCall',
    priority: 1, // Run first in afterModelCall — before any other post-processing
    execute(ctx: unknown): HookResult | void {
      const hookCtx = ctx as {
        runId?: string;
        agentId?: string;
        turnIndex?: number;
        response?: {
          content?: string;
          rawBody?: string;
          provider?: string;
          model?: string;
          finishReason?: string;
          httpStatus?: number;
          endpoint?: string;
          tlsCertFingerprint?: string;
          usage?: unknown;
        };
        requestBody?: string;
      };

      if (!hookCtx.response) return;

      const responseBody = hookCtx.response.rawBody
        ?? hookCtx.response.content
        ?? JSON.stringify(hookCtx.response);

      const record = logger.record({
        responseBody,
        requestBody: hookCtx.requestBody,
        provider: hookCtx.response.provider ?? 'unknown',
        model: hookCtx.response.model ?? 'unknown',
        endpoint: hookCtx.response.endpoint,
        tlsCertFingerprint: hookCtx.response.tlsCertFingerprint,
        runId: hookCtx.runId ?? 'unknown',
        agentId: hookCtx.agentId ?? 'unknown',
        turnIndex: hookCtx.turnIndex ?? 0,
        httpStatus: hookCtx.response.httpStatus,
        finishReason: hookCtx.response.finishReason,
      });

      return {
        annotations: {
          responseHashRecord: {
            id: record.id,
            responseBodyHash: record.responseBodyHash,
            requestBodyHash: record.requestBodyHash,
            contentLength: record.contentLength,
          },
        },
      };
    },
  };

  return {
    id: 'security:response-hash-logging',
    name: 'Raw Response Hash Logging',
    description: 'Computes and stores SHA-256 hashes of raw LLM responses before parsing. Enables post-incident forensic comparison. Addresses AC-1 forensics.',
    version: '1.0.0',
    rules: [],
    hooks: [hook],
  };
}

/** Export the logger class for direct use. */
export { RawResponseHashLogger as ResponseHashLogger };
