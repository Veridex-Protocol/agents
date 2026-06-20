/**
 * @module NLIBackends
 * @description
 * Concrete `NLIBackend` implementations that work **without training a custom
 * model**. Each is a drop-in for `IntentVerifier`'s existing `NLIBackend`
 * contract — they differ in cost, latency, and precision.
 *
 * Choice guide:
 *
 *   • `KeywordOverlapNLIBackend`
 *       Zero network, zero cost. Token-overlap + Jaccard similarity. Coarse
 *       but instant. Good as a cheap pre-filter or degraded-mode fallback.
 *
 *   • `EmbeddingSimilarityNLIBackend`
 *       Cosine similarity of embeddings. Needs an embedding function (bring
 *       your own — OpenAI embeddings, Voyage, local all-MiniLM, etc.).
 *       Strong semantic signal. Cheap ($0.00002 per call for OpenAI small).
 *
 *   • `LLMJudgeNLIBackend`
 *       Asks any chat LLM "does this action match this intent? Score 0-1."
 *       Highest precision, highest cost/latency. Parses a JSON response;
 *       enforces output shape with Zod. Automatically retries on malformed
 *       output once.
 *
 *   • `CompositeNLIBackend`
 *       Runs N backends and aggregates (max / avg / min). Use for defence
 *       in depth — e.g. embedding-sim AS a cheap first pass, LLM-judge as a
 *       confidence booster only on ambiguous scores.
 *
 * All of these fit the existing pluggable `NLIBackend` interface, so swapping
 * between them is a one-line config change.
 */

import { z } from 'zod';
import type { NLIBackend } from './IntentVerification';

// ── 1. Keyword-overlap baseline ─────────────────────────────────────────────

export interface KeywordOverlapConfig {
  /** Tokens shorter than this are dropped as stopwords-adjacent. Default 3. */
  minTokenLength?: number;
  /**
   * Optional stopword list (lowercased). Defaults to a small English set.
   * Supply `[]` to disable stopword removal entirely.
   */
  stopwords?: ReadonlyArray<string>;
}

const DEFAULT_STOPWORDS: ReadonlyArray<string> = [
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'to', 'of', 'in', 'on',
  'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'will', 'would',
  'should', 'could', 'can', 'this', 'that', 'these', 'those', 'it', 'its',
];

/**
 * Pure-JS Jaccard similarity of the token sets of premise and hypothesis.
 * Works offline, zero deps beyond zod. Intended as a cheap baseline OR a
 * `CompositeNLIBackend` input — not a standalone production guard.
 */
export class KeywordOverlapNLIBackend implements NLIBackend {
  private readonly minLen: number;
  private readonly stopwords: Set<string>;

  constructor(config: KeywordOverlapConfig = {}) {
    this.minLen = config.minTokenLength ?? 3;
    this.stopwords = new Set(config.stopwords ?? DEFAULT_STOPWORDS);
  }

  async score(premise: string, hypothesis: string): Promise<number> {
    const a = this.tokenize(premise);
    const b = this.tokenize(hypothesis);
    if (a.size === 0 || b.size === 0) return 0;

    let intersect = 0;
    for (const t of a) if (b.has(t)) intersect++;
    const union = new Set([...a, ...b]).size;
    return union === 0 ? 0 : intersect / union;
  }

  private tokenize(text: string): Set<string> {
    const out = new Set<string>();
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < this.minLen) continue;
      if (this.stopwords.has(raw)) continue;
      out.add(raw);
    }
    return out;
  }
}

// ── 2. Embedding-similarity backend ─────────────────────────────────────────

/** Function that returns the embedding vector for a single text input. */
export type EmbedFn = (text: string) => Promise<ReadonlyArray<number>>;

export interface EmbeddingSimilarityConfig {
  embed: EmbedFn;
  /**
   * Map cosine sim ∈ [-1, 1] to [0, 1]. Default = `(sim + 1) / 2`. Override
   * if your embedder only emits non-negative vectors (cosine ∈ [0, 1]).
   */
  normalize?: (cosineSim: number) => number;
  /** Small in-memory LRU for repeated premises. Default 128 entries. */
  cacheSize?: number;
}

/**
 * Cosine-similarity NLI backend. Works with any embedder (`EmbedFn`).
 * Recommended pairings:
 *   • OpenAI `text-embedding-3-small` — ~1536 dims, ~$0.00002/1k tok
 *   • Cohere `embed-english-light-v3.0`
 *   • local `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers`
 */
export class EmbeddingSimilarityNLIBackend implements NLIBackend {
  private readonly embed: EmbedFn;
  private readonly normalize: (s: number) => number;
  private readonly cache: Map<string, ReadonlyArray<number>>;
  private readonly cacheCap: number;

  constructor(config: EmbeddingSimilarityConfig) {
    this.embed = config.embed;
    this.normalize = config.normalize ?? ((s) => (s + 1) / 2);
    this.cacheCap = config.cacheSize ?? 128;
    this.cache = new Map();
  }

  async score(premise: string, hypothesis: string): Promise<number> {
    const [p, h] = await Promise.all([this.getEmbed(premise), this.getEmbed(hypothesis)]);
    const sim = cosine(p, h);
    const normalized = this.normalize(sim);
    // Clamp defensively — normalize may overshoot on pathological input.
    return Math.max(0, Math.min(1, normalized));
  }

  private async getEmbed(text: string): Promise<ReadonlyArray<number>> {
    const hit = this.cache.get(text);
    if (hit) {
      // LRU touch: re-insert.
      this.cache.delete(text);
      this.cache.set(text, hit);
      return hit;
    }
    const vec = await this.embed(text);
    this.cache.set(text, vec);
    if (this.cache.size > this.cacheCap) {
      // Drop the oldest entry (Map preserves insertion order).
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    return vec;
  }
}

function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  const denom = Math.sqrt(aMag) * Math.sqrt(bMag);
  return denom === 0 ? 0 : dot / denom;
}

// ── 3. LLM-judge backend ────────────────────────────────────────────────────

/**
 * Minimal chat-completion shape compatible with OpenAI, Anthropic (wrapped),
 * and most self-hosted gateways. Bring your own client; we only need this
 * single-method adapter so we don't hard-depend on any SDK.
 */
export type ChatCompletionFn = (input: {
    system: string;
    user: string;
    /** Abort after this many ms. Caller may wire to AbortController. */
    timeoutMs?: number;
  }) => Promise<string>

export interface LLMJudgeConfig {
  chat: ChatCompletionFn;
  /** Override the system prompt if your judge needs different framing. */
  systemPrompt?: string;
  /** Max ms for the underlying call. Default 10000. */
  timeoutMs?: number;
}

const JudgeResponseSchema = z.object({
  score: z.number().min(0).max(1),
  reasoning: z.string().optional(),
});

const DEFAULT_JUDGE_SYSTEM = `You are an intent-alignment judge. Given a declared intent (premise) and a proposed action (hypothesis), reply with a single JSON object: {"score": <0-1 float>, "reasoning": "<short>"}. The score is how well the action fits the declared intent — 1.0 = perfect fit, 0.0 = unrelated or contradictory. Be strict: ambiguous matches score ≤0.5.`;

/**
 * Uses any chat LLM as an NLI judge. Parses the model's reply as JSON and
 * validates with Zod. Retries once on malformed output. Fail-closed: on
 * persistent parse failure, returns 0 (no alignment).
 */
export class LLMJudgeNLIBackend implements NLIBackend {
  private readonly chat: ChatCompletionFn;
  private readonly systemPrompt: string;
  private readonly timeoutMs: number;

  constructor(config: LLMJudgeConfig) {
    this.chat = config.chat;
    this.systemPrompt = config.systemPrompt ?? DEFAULT_JUDGE_SYSTEM;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async score(premise: string, hypothesis: string): Promise<number> {
    const user = `PREMISE (declared intent):\n${premise}\n\nHYPOTHESIS (proposed action):\n${hypothesis}\n\nReturn ONLY the JSON object.`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.chat({
          system: this.systemPrompt,
          user,
          timeoutMs: this.timeoutMs,
        });
        const parsed = extractJson(raw);
        const validated = JudgeResponseSchema.parse(parsed);
        return validated.score;
      } catch {
        if (attempt === 1) return 0; // fail-closed after second attempt
      }
    }
    return 0;
  }
}

/** Tolerant JSON extractor for LLM outputs that may include code fences. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Try direct first.
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // Strip code fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
  }
  // Last resort: extract the first {...} span.
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error('no JSON found');
}

// ── 4. Composite backend ────────────────────────────────────────────────────

export type CompositeStrategy = 'max' | 'min' | 'avg';

export interface CompositeConfig {
  backends: ReadonlyArray<NLIBackend>;
  /** How to combine scores. Default 'max' — most-permissive wins. */
  strategy?: CompositeStrategy;
}

/**
 * Defence in depth: runs multiple backends in parallel and aggregates.
 *
 *   • 'max' — any backend finding alignment passes (permissive).
 *   • 'min' — all backends must agree on alignment (strict).
 *   • 'avg' — arithmetic mean.
 */
export class CompositeNLIBackend implements NLIBackend {
  private readonly backends: ReadonlyArray<NLIBackend>;
  private readonly strategy: CompositeStrategy;

  constructor(config: CompositeConfig) {
    if (config.backends.length === 0) {
      throw new Error('CompositeNLIBackend: at least one backend is required');
    }
    this.backends = config.backends;
    this.strategy = config.strategy ?? 'max';
  }

  async score(premise: string, hypothesis: string): Promise<number> {
    const scores = await Promise.all(
      this.backends.map((b) => b.score(premise, hypothesis).catch(() => 0)),
    );
    switch (this.strategy) {
      case 'max':
        return Math.max(...scores);
      case 'min':
        return Math.min(...scores);
      case 'avg':
        return scores.reduce((s, v) => s + v, 0) / scores.length;
    }
  }
}
