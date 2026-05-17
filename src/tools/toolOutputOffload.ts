/**
 * @packageDocumentation
 * @module toolOutputOffload
 * @description
 * Helper for **offloading oversized tool outputs out of the model
 * context**. Large tool results (file dumps, scraped HTML, API
 * payloads, big query responses) are the single biggest cause of
 * context bloat in agent runs: a 50 KB blob inflates every subsequent
 * turn's prompt and pushes the prompt past the effective context
 * window (see the Root Theorem in
 * {@link HomeostaticContextEngine}).
 *
 * This module provides a side-effect-free decision function plus a
 * tiny pluggable storage adapter so callers can swap the on-disk
 * backend for an in-memory one in tests, or for an object store
 * (S3/GCS) in production.
 *
 * The returned envelope ({@link OffloadEnvelope}) is what the runtime
 * actually puts into the conversation: a small head/tail slice with a
 * reference the agent can follow via a follow-up tool call (e.g.
 * `read_tool_output(ref, range)`).
 */

/** Roughly 4 characters per token (heuristic matches ContextCompiler). */
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Result returned to the runtime / agent. */
export interface OffloadEnvelope {
  /** Whether offloading actually happened. */
  offloaded: boolean;
  /** Head slice (kept inline). */
  head: string;
  /** Tail slice (kept inline). Empty when content is smaller than 2x slice. */
  tail: string;
  /** Reference token (e.g. file path or storage key) — undefined when not offloaded. */
  ref?: string;
  /** Token count of the original payload. */
  fullTokens: number;
  /** Tokens removed from the inline copy. */
  droppedTokens: number;
  /** Bytes of the original payload. */
  fullBytes: number;
  /** SHA-256-truncated hash used in the ref. */
  contentHash?: string;
}

/** Pluggable storage backend. */
export interface OffloadStorage {
  /**
   * Persist `content` for `runId`/`toolName`. Returns a string
   * reference that the runtime can later resolve. Implementations may
   * choose any layout — the ref is opaque to the caller.
   */
  write(args: {
    runId: string;
    toolName: string;
    content: string;
    contentHash: string;
  }): Promise<string>;
}

/** Options for {@link offloadToolOutput}. */
export interface OffloadOptions {
  /** Original tool output. */
  content: string;
  /** Run ID — used in the storage key. */
  runId: string;
  /** Tool name — used in the storage key. */
  toolName: string;
  /** Pluggable storage backend. */
  storage: OffloadStorage;
  /**
   * Token threshold above which offloading triggers. Defaults to
   * `2000` tokens (~8 KB). Below this, the original content passes
   * through unchanged.
   */
  thresholdTokens?: number;
  /**
   * Number of characters kept at the head of the inline copy.
   * Defaults to `1024` (~256 tokens).
   */
  headChars?: number;
  /**
   * Number of characters kept at the tail of the inline copy.
   * Defaults to `512` (~128 tokens).
   */
  tailChars?: number;
}

const DEFAULT_THRESHOLD_TOKENS = 2000;
const DEFAULT_HEAD_CHARS = 1024;
const DEFAULT_TAIL_CHARS = 512;

/**
 * Decide whether `content` is too large to stay inline, and if so
 * persist the full body via `storage` and return a head/tail envelope
 * with a reference. Idempotent in the sense that it returns the same
 * envelope for the same input + storage; storage implementations are
 * expected to be content-addressable (we hash the body).
 */
export async function offloadToolOutput(
  options: OffloadOptions,
): Promise<OffloadEnvelope> {
  const {
    content,
    runId,
    toolName,
    storage,
    thresholdTokens = DEFAULT_THRESHOLD_TOKENS,
    headChars = DEFAULT_HEAD_CHARS,
    tailChars = DEFAULT_TAIL_CHARS,
  } = options;

  const fullTokens = estimateTokens(content);
  const fullBytes = content.length;

  if (fullTokens <= thresholdTokens) {
    return {
      offloaded: false,
      head: content,
      tail: '',
      fullTokens,
      droppedTokens: 0,
      fullBytes,
    };
  }

  // Don't offload if head+tail already covers the body.
  if (headChars + tailChars >= content.length) {
    return {
      offloaded: false,
      head: content,
      tail: '',
      fullTokens,
      droppedTokens: 0,
      fullBytes,
    };
  }

  const head = content.slice(0, headChars);
  const tail = content.slice(content.length - tailChars);
  const contentHash = await shortHash(content);
  const ref = await storage.write({ runId, toolName, content, contentHash });

  const inlineChars = head.length + tail.length;
  const droppedTokens = Math.max(0, estimateTokens(content) - estimateTokens(content.slice(0, inlineChars)));

  return {
    offloaded: true,
    head,
    tail,
    ref,
    fullTokens,
    droppedTokens,
    fullBytes,
    contentHash,
  };
}

/**
 * Render an {@link OffloadEnvelope} into a single string suitable for
 * inlining into a tool-result message. Includes the head, an
 * elision marker, and the tail, plus the storage ref so the agent can
 * fetch the full body if needed.
 */
export function renderOffloadEnvelope(env: OffloadEnvelope): string {
  if (!env.offloaded) return env.head;
  const elision = `\n\n[... ${env.droppedTokens} tokens elided; full payload at ref: ${env.ref} ...]\n\n`;
  return env.head + elision + env.tail;
}

/**
 * SHA-256 hash, truncated to 16 hex chars. Uses Web Crypto when
 * available (Node ≥ 19 and browsers), falls back to a non-crypto
 * polyfill only if absolutely necessary — sufficient for content
 * addressing of tool outputs.
 */
async function shortHash(content: string): Promise<string> {
  const subtle: SubtleCrypto | undefined = (globalThis as { crypto?: { subtle?: SubtleCrypto } })
    .crypto?.subtle;
  if (subtle) {
    const bytes = new TextEncoder().encode(content);
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // FNV-1a fallback (collision-tolerant — only used when crypto is
  // unavailable, which should not happen in supported runtimes).
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── Default storage backends ───────────────────────────────────────

/**
 * In-memory storage suitable for tests and single-process runtimes.
 * Stores payloads in a `Map<ref, content>` and exposes `read(ref)` for
 * tests/clients. Refs have the shape `mem://<runId>/<toolName>/<hash>`.
 */
export class InMemoryOffloadStorage implements OffloadStorage {
  private readonly store = new Map<string, string>();

  async write(args: {
    runId: string;
    toolName: string;
    content: string;
    contentHash: string;
  }): Promise<string> {
    const ref = `mem://${args.runId}/${args.toolName}/${args.contentHash}`;
    this.store.set(ref, args.content);
    return ref;
  }

  read(ref: string): string | undefined {
    return this.store.get(ref);
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}
