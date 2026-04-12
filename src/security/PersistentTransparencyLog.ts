/**
 * @packageDocumentation
 * @module PersistentTransparencyLog
 * @description
 * Extends RemoteCallTracer with persistent, append-only logging to disk.
 * Each entry includes: request body hash, response body hash, router URL,
 * TLS cert fingerprint, and timestamps.
 *
 * Addresses AC-1 and AC-2 forensics from "Your Agent Is Mine":
 * - Provides tamper-evident audit trail of all model/transport interactions
 * - Enables post-incident investigation of compromised router behavior
 * - ~1.26 KB/entry per the paper's measurements
 *
 * Storage format: JSONL (JSON Lines) — one JSON object per line, append-only.
 */

import { createHash } from 'crypto';
import { appendFile, readFile, stat, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import type { RuntimeHook, HookResult } from '../types/hooks';
import type { SecurityPolicyPack } from './types';

// ── Types ──

export interface TransparencyLogEntry {
  /** Unique entry ID */
  id: string;
  /** Entry type */
  type: 'model_call' | 'transport_call' | 'tool_call' | 'security_event';
  /** Timestamp (ISO 8601) */
  timestamp: string;
  /** Unix epoch ms */
  epochMs: number;
  /** SHA-256 of the request body */
  requestBodyHash?: string;
  /** SHA-256 of the response body */
  responseBodyHash?: string;
  /** Provider/router endpoint URL */
  endpoint?: string;
  /** TLS certificate fingerprint (SHA-256 of DER) */
  tlsCertFingerprint?: string;
  /** LLM provider name */
  provider?: string;
  /** Model name */
  model?: string;
  /** Run ID */
  runId: string;
  /** Agent ID */
  agentId: string;
  /** Turn index within the run */
  turnIndex?: number;
  /** Additional structured data */
  data?: Record<string, unknown>;
  /** SHA-256 hash of the previous entry (chain integrity) */
  previousEntryHash?: string;
}

export interface TransparencyLogConfig {
  /** Directory to store log files (default: '.veridex/transparency-logs'). */
  logDir?: string;
  /** Base filename prefix (default: 'transparency'). */
  filePrefix?: string;
  /** Whether to chain-hash entries for tamper evidence (default: true). */
  chainHash?: boolean;
  /** Max entries per file before rotation (default: 50000). */
  maxEntriesPerFile?: number;
  /** Whether to flush after each write (default: true). */
  flushImmediate?: boolean;
  /** Also retain entries in memory for querying (default: true, max 5000). */
  retainInMemory?: boolean;
  /** Max in-memory entries (default: 5000). */
  maxInMemoryEntries?: number;
}

// ── Implementation ──

let logEntryCounter = 0;

export class PersistentTransparencyLog {
  private readonly config: Required<TransparencyLogConfig>;
  private lastEntryHash: string | undefined;
  private entryCount = 0;
  private fileIndex = 0;
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly inMemoryEntries: TransparencyLogEntry[] = [];

  constructor(config?: TransparencyLogConfig) {
    this.config = {
      logDir: config?.logDir ?? '.veridex/transparency-logs',
      filePrefix: config?.filePrefix ?? 'transparency',
      chainHash: config?.chainHash ?? true,
      maxEntriesPerFile: config?.maxEntriesPerFile ?? 50_000,
      flushImmediate: config?.flushImmediate ?? true,
      retainInMemory: config?.retainInMemory ?? true,
      maxInMemoryEntries: config?.maxInMemoryEntries ?? 5_000,
    };
  }

  /**
   * Ensure the log directory exists.
   */
  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    try {
      await mkdir(this.config.logDir, { recursive: true });
    } catch {
      // Directory may already exist
    }
    this.initialized = true;
  }

  /**
   * Get the current log file path.
   */
  private getCurrentFilePath(): string {
    return join(
      this.config.logDir,
      `${this.config.filePrefix}_${this.fileIndex.toString().padStart(4, '0')}.jsonl`,
    );
  }

  /**
   * Compute SHA-256 hash of an entry (for chain integrity).
   */
  private static hashEntry(entry: TransparencyLogEntry): string {
    const canonical = JSON.stringify(entry);
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Compute SHA-256 hash of arbitrary content.
   */
  static hashContent(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Append an entry to the log.
   */
  async append(
    params: Omit<TransparencyLogEntry, 'id' | 'timestamp' | 'epochMs' | 'previousEntryHash'>,
  ): Promise<TransparencyLogEntry> {
    logEntryCounter++;
    const now = Date.now();

    const entry: TransparencyLogEntry = {
      ...params,
      id: `tlog_${now}_${logEntryCounter}`,
      timestamp: new Date(now).toISOString(),
      epochMs: now,
      previousEntryHash: this.config.chainHash ? this.lastEntryHash : undefined,
    };

    // Update chain hash
    if (this.config.chainHash) {
      this.lastEntryHash = PersistentTransparencyLog.hashEntry(entry);
    }

    // Retain in memory
    if (this.config.retainInMemory) {
      this.inMemoryEntries.push(entry);
      while (this.inMemoryEntries.length > this.config.maxInMemoryEntries) {
        this.inMemoryEntries.shift();
      }
    }

    // Write to disk (serialized to prevent interleaved writes)
    this.writeQueue = this.writeQueue.then(async () => {
      await this.ensureDir();

      // Rotate file if needed
      if (this.entryCount >= this.config.maxEntriesPerFile) {
        this.fileIndex++;
        this.entryCount = 0;
      }

      const line = JSON.stringify(entry) + '\n';
      await appendFile(this.getCurrentFilePath(), line, 'utf-8');
      this.entryCount++;
    });

    await this.writeQueue;
    return entry;
  }

  /**
   * Log a model call (before + after).
   */
  async logModelCall(params: {
    requestBody?: string;
    responseBody?: string;
    provider: string;
    model: string;
    endpoint?: string;
    tlsCertFingerprint?: string;
    runId: string;
    agentId: string;
    turnIndex: number;
    finishReason?: string;
    latencyMs?: number;
  }): Promise<TransparencyLogEntry> {
    return this.append({
      type: 'model_call',
      requestBodyHash: params.requestBody
        ? PersistentTransparencyLog.hashContent(params.requestBody)
        : undefined,
      responseBodyHash: params.responseBody
        ? PersistentTransparencyLog.hashContent(params.responseBody)
        : undefined,
      endpoint: params.endpoint,
      tlsCertFingerprint: params.tlsCertFingerprint,
      provider: params.provider,
      model: params.model,
      runId: params.runId,
      agentId: params.agentId,
      turnIndex: params.turnIndex,
      data: {
        finishReason: params.finishReason,
        latencyMs: params.latencyMs,
      },
    });
  }

  /**
   * Log a security event (blocked action, redaction, etc.).
   */
  async logSecurityEvent(params: {
    runId: string;
    agentId: string;
    turnIndex?: number;
    eventType: string;
    description: string;
    severity: 'info' | 'warning' | 'critical';
    data?: Record<string, unknown>;
  }): Promise<TransparencyLogEntry> {
    return this.append({
      type: 'security_event',
      runId: params.runId,
      agentId: params.agentId,
      turnIndex: params.turnIndex,
      data: {
        eventType: params.eventType,
        description: params.description,
        severity: params.severity,
        ...params.data,
      },
    });
  }

  /**
   * Get in-memory entries (most recent).
   */
  getRecentEntries(count?: number): ReadonlyArray<TransparencyLogEntry> {
    const c = count ?? this.inMemoryEntries.length;
    return this.inMemoryEntries.slice(-c);
  }

  /**
   * Get entries by run ID.
   */
  getByRun(runId: string): TransparencyLogEntry[] {
    return this.inMemoryEntries.filter((e) => e.runId === runId);
  }

  /**
   * Verify chain integrity of in-memory entries.
   * Returns the first broken link index, or -1 if chain is intact.
   */
  verifyChainIntegrity(): number {
    if (!this.config.chainHash || this.inMemoryEntries.length < 2) return -1;

    for (let i = 1; i < this.inMemoryEntries.length; i++) {
      const expectedHash = PersistentTransparencyLog.hashEntry(this.inMemoryEntries[i - 1]);
      if (this.inMemoryEntries[i].previousEntryHash !== expectedHash) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Read entries from a log file on disk.
   */
  async readLogFile(filePath: string): Promise<TransparencyLogEntry[]> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as TransparencyLogEntry);
    } catch {
      return [];
    }
  }

  /**
   * Get total entries written across all files.
   */
  getTotalEntries(): number {
    return this.fileIndex * this.config.maxEntriesPerFile + this.entryCount;
  }

  /**
   * Get the log directory path.
   */
  getLogDir(): string {
    return this.config.logDir;
  }
}

// ── Security Policy Pack ──

export interface TransparencyLogPackOptions {
  /** Log directory path. */
  logDir?: string;
  /** Whether to chain-hash entries (default: true). */
  chainHash?: boolean;
  /** Max entries per file (default: 50000). */
  maxEntriesPerFile?: number;
  /** External record callback (e.g., for shipping to SIEM). */
  onEntry?: (entry: TransparencyLogEntry) => void | Promise<void>;
}

/**
 * Creates a persistent transparency log security pack.
 *
 * Installs hooks at afterModelCall and onPolicyViolation to log
 * all model interactions and security events to append-only files.
 */
export function persistentTransparencyLogPack(opts?: TransparencyLogPackOptions): SecurityPolicyPack {
  const log = new PersistentTransparencyLog({
    logDir: opts?.logDir,
    chainHash: opts?.chainHash,
    maxEntriesPerFile: opts?.maxEntriesPerFile,
  });

  const onEntry = opts?.onEntry;

  const afterModelCallHook: RuntimeHook = {
    name: 'security:transparency-log-model',
    phase: 'afterModelCall',
    priority: 2, // After response hash logging (priority 1)
    execute(ctx: unknown): void {
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
          endpoint?: string;
          tlsCertFingerprint?: string;
        };
        requestBody?: string;
        latencyMs?: number;
      };

      if (!hookCtx.response) return;

      // Fire and forget — don't block the model call pipeline
      void log.logModelCall({
        requestBody: hookCtx.requestBody,
        responseBody: hookCtx.response.rawBody ?? hookCtx.response.content,
        provider: hookCtx.response.provider ?? 'unknown',
        model: hookCtx.response.model ?? 'unknown',
        endpoint: hookCtx.response.endpoint,
        tlsCertFingerprint: hookCtx.response.tlsCertFingerprint,
        runId: hookCtx.runId ?? 'unknown',
        agentId: hookCtx.agentId ?? 'unknown',
        turnIndex: hookCtx.turnIndex ?? 0,
        finishReason: hookCtx.response.finishReason,
        latencyMs: hookCtx.latencyMs,
      }).then((entry) => onEntry?.(entry));
    },
  };

  const policyViolationHook: RuntimeHook = {
    name: 'security:transparency-log-violation',
    phase: 'onPolicyViolation',
    priority: 5,
    execute(ctx: unknown): void {
      const hookCtx = ctx as {
        runId?: string;
        agentId?: string;
        turnIndex?: number;
        violation?: {
          ruleId?: string;
          ruleName?: string;
          reason?: string;
          verdict?: string;
        };
      };

      void log.logSecurityEvent({
        runId: hookCtx.runId ?? 'unknown',
        agentId: hookCtx.agentId ?? 'unknown',
        turnIndex: hookCtx.turnIndex,
        eventType: 'policy_violation',
        description: hookCtx.violation?.reason ?? 'Unknown policy violation',
        severity: hookCtx.violation?.verdict === 'block' ? 'critical' : 'warning',
        data: {
          ruleId: hookCtx.violation?.ruleId,
          ruleName: hookCtx.violation?.ruleName,
          verdict: hookCtx.violation?.verdict,
        },
      }).then((entry) => onEntry?.(entry));
    },
  };

  return {
    id: 'security:persistent-transparency-log',
    name: 'Persistent Transparency Log',
    description: 'Append-only, chain-hashed transparency log for all model calls and security events. Written to disk as JSONL. Addresses AC-1 and AC-2 forensics.',
    version: '1.0.0',
    rules: [],
    hooks: [afterModelCallHook, policyViolationHook],
  };
}

/** Export the log class for direct use. */
export { PersistentTransparencyLog as TransparencyLog };
