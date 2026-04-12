/**
 * @module IntentVerification
 * @description
 * Intent verification pipeline for agent actions.
 * Implements a three-stage filter:
 *
 * 1. **KeywordFilter** — Fast regex-based blocklist for known dangerous patterns
 * 2. **NLIVerifier** — Natural Language Inference scoring (pluggable backend)
 * 3. **BenignOverride** — Allowlist for known-safe patterns that bypass deeper checks
 *
 * The composite **IntentVerifier** runs all stages and produces a final verdict.
 *
 * @see ADR-0045 — Phase 2: Intent Verification
 */

// ── Types ──

/** Result from any single intent verification stage. */
export interface IntentCheckResult {
  /** Stage that produced this result */
  stage: 'keyword' | 'nli' | 'benign_override' | 'composite';
  /** Whether the intent passed this stage */
  passed: boolean;
  /** Confidence score 0-1 (1 = fully confident) */
  confidence: number;
  /** Human-readable reason */
  reason: string;
  /** Matched pattern/keyword if applicable */
  matchedPattern?: string;
}

/** Final verdict from the composite IntentVerifier. */
export interface IntentVerdict {
  /** Whether the intent is allowed */
  allowed: boolean;
  /** Overall confidence (min across stages) */
  confidence: number;
  /** All stage results */
  stageResults: IntentCheckResult[];
  /** Reasons for denial (empty if allowed) */
  reasons: string[];
  /** Processing time in ms */
  durationMs: number;
}

/** Intent context for verification. */
export interface IntentContext {
  /** The proposed action description (from tool call or agent delegation) */
  action: string;
  /** Source agent identifier */
  agentId: string;
  /** Target resource or endpoint (optional) */
  target?: string;
  /** Amount in USD (for financial actions) */
  amountUSD?: number;
  /** Chain identifier (for on-chain actions) */
  chain?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

// ── Keyword Filter ──

/** Configuration for the keyword filter. */
export interface KeywordFilterConfig {
  /** Blocked patterns (regex strings, case-insensitive) */
  blocklist: string[];
  /** Allowed patterns that override blocklist matches */
  allowlist?: string[];
}

/**
 * KeywordFilter — fast regex-based blocklist scan.
 * Blocks actions containing known dangerous keywords/patterns.
 */
export class KeywordFilter {
  private readonly blockPatterns: RegExp[];
  private readonly allowPatterns: RegExp[];

  constructor(config: KeywordFilterConfig) {
    this.blockPatterns = config.blocklist.map((p) => new RegExp(p, 'i'));
    this.allowPatterns = (config.allowlist ?? []).map((p) => new RegExp(p, 'i'));
  }

  /** Check an action string against the blocklist. */
  check(action: string): IntentCheckResult {
    // Check allowlist first — allowlisted patterns bypass blocking
    for (const pattern of this.allowPatterns) {
      if (pattern.test(action)) {
        return {
          stage: 'keyword',
          passed: true,
          confidence: 1.0,
          reason: `Action matches allowlist pattern: ${pattern.source}`,
          matchedPattern: pattern.source,
        };
      }
    }

    for (const pattern of this.blockPatterns) {
      if (pattern.test(action)) {
        return {
          stage: 'keyword',
          passed: false,
          confidence: 1.0,
          reason: `Action matches blocked pattern: ${pattern.source}`,
          matchedPattern: pattern.source,
        };
      }
    }

    return {
      stage: 'keyword',
      passed: true,
      confidence: 1.0,
      reason: 'No blocked keywords matched',
    };
  }
}

/** Default keyword blocklist for financial agent actions. */
export const DEFAULT_FINANCIAL_BLOCKLIST: string[] = [
  'drain\\s+wallet',
  'send\\s+all\\s+funds',
  'transfer\\s+entire\\s+balance',
  'infinite\\s+approve',
  'unlimited\\s+approval',
  'private\\s+key',
  'seed\\s+phrase',
  'mnemonic',
  'rug\\s+pull',
  'flash\\s+loan\\s+attack',
  'front\\s*run',
  'sandwich\\s+attack',
];

// ── NLI Verifier ──

/** Backend interface for NLI scoring. Pluggable to any NLI provider. */
export interface NLIBackend {
  /** Score how well an action aligns with a reference intent. Returns 0-1. */
  score(premise: string, hypothesis: string): Promise<number>;
}

/** Configuration for the NLI verifier. */
export interface NLIVerifierConfig {
  /** NLI scoring backend */
  backend: NLIBackend;
  /** Minimum score to pass (default: 0.6) */
  threshold?: number;
  /** Reference intent descriptions for the agent's declared purpose */
  referenceIntents: string[];
}

/**
 * NLIVerifier — uses Natural Language Inference to check if
 * an action aligns with the agent's declared intent/purpose.
 */
export class NLIVerifier {
  private readonly backend: NLIBackend;
  private readonly threshold: number;
  private readonly referenceIntents: string[];

  constructor(config: NLIVerifierConfig) {
    this.backend = config.backend;
    this.threshold = config.threshold ?? 0.6;
    this.referenceIntents = config.referenceIntents;
  }

  /** Verify an action against all reference intents. Best score wins. */
  async verify(action: string): Promise<IntentCheckResult> {
    if (this.referenceIntents.length === 0) {
      return {
        stage: 'nli',
        passed: true,
        confidence: 0.5,
        reason: 'No reference intents configured — defaulting to pass',
      };
    }

    let bestScore = 0;
    let bestIntent = '';

    for (const intent of this.referenceIntents) {
      const score = await this.backend.score(intent, action);
      if (score > bestScore) {
        bestScore = score;
        bestIntent = intent;
      }
    }

    const passed = bestScore >= this.threshold;
    return {
      stage: 'nli',
      passed,
      confidence: bestScore,
      reason: passed
        ? `Action aligns with intent: "${bestIntent}" (score: ${bestScore.toFixed(2)})`
        : `Action does not align with any declared intent (best: ${bestScore.toFixed(2)}, threshold: ${this.threshold})`,
      matchedPattern: bestIntent || undefined,
    };
  }
}

// ── Benign Override ──

/** Configuration for benign override patterns. */
export interface BenignOverrideConfig {
  /** Patterns that are always considered safe */
  safePatterns: string[];
  /** Maximum USD amount for auto-approval (optional) */
  maxAutoApproveUSD?: number;
}

/**
 * BenignOverride — allowlist for known-safe action patterns.
 * If an action matches a safe pattern (and is under the amount cap),
 * it bypasses deeper intent verification.
 */
export class BenignOverride {
  private readonly safePatterns: RegExp[];
  private readonly maxAutoApproveUSD: number;

  constructor(config: BenignOverrideConfig) {
    this.safePatterns = config.safePatterns.map((p) => new RegExp(p, 'i'));
    this.maxAutoApproveUSD = config.maxAutoApproveUSD ?? Infinity;
  }

  /** Check if an action qualifies for benign override. */
  check(ctx: IntentContext): IntentCheckResult {
    if (ctx.amountUSD !== undefined && ctx.amountUSD > this.maxAutoApproveUSD) {
      return {
        stage: 'benign_override',
        passed: false,
        confidence: 1.0,
        reason: `Amount $${ctx.amountUSD} exceeds auto-approve cap $${this.maxAutoApproveUSD}`,
      };
    }

    for (const pattern of this.safePatterns) {
      if (pattern.test(ctx.action)) {
        return {
          stage: 'benign_override',
          passed: true,
          confidence: 1.0,
          reason: `Action matches safe pattern: ${pattern.source}`,
          matchedPattern: pattern.source,
        };
      }
    }

    return {
      stage: 'benign_override',
      passed: false,
      confidence: 1.0,
      reason: 'No safe pattern matched — proceed to deeper verification',
    };
  }
}

// ── Composite Intent Verifier ──

/** Configuration for the composite intent verifier. */
export interface IntentVerifierConfig {
  /** Keyword filter (optional but recommended) */
  keywordFilter?: KeywordFilter;
  /** NLI verifier (optional — skipped if not provided) */
  nliVerifier?: NLIVerifier;
  /** Benign override (optional) */
  benignOverride?: BenignOverride;
}

/**
 * IntentVerifier — composite pipeline that runs all verification stages
 * in order: KeywordFilter → BenignOverride → NLIVerifier.
 *
 * Short-circuits on keyword block. Skips NLI if benign override matches.
 */
export class IntentVerifier {
  private readonly keywordFilter?: KeywordFilter;
  private readonly nliVerifier?: NLIVerifier;
  private readonly benignOverride?: BenignOverride;

  constructor(config: IntentVerifierConfig) {
    this.keywordFilter = config.keywordFilter;
    this.nliVerifier = config.nliVerifier;
    this.benignOverride = config.benignOverride;
  }

  /** Run the full verification pipeline. */
  async verify(ctx: IntentContext): Promise<IntentVerdict> {
    const start = Date.now();
    const stageResults: IntentCheckResult[] = [];
    const reasons: string[] = [];

    // Stage 1: Keyword filter
    if (this.keywordFilter) {
      const kwResult = this.keywordFilter.check(ctx.action);
      stageResults.push(kwResult);
      if (!kwResult.passed) {
        reasons.push(kwResult.reason);
        return {
          allowed: false,
          confidence: kwResult.confidence,
          stageResults,
          reasons,
          durationMs: Date.now() - start,
        };
      }
    }

    // Stage 2: Benign override (if match, skip NLI)
    if (this.benignOverride) {
      const benignResult = this.benignOverride.check(ctx);
      stageResults.push(benignResult);
      if (benignResult.passed) {
        return {
          allowed: true,
          confidence: benignResult.confidence,
          stageResults,
          reasons: [],
          durationMs: Date.now() - start,
        };
      }
    }

    // Stage 3: NLI verification
    if (this.nliVerifier) {
      const nliResult = await this.nliVerifier.verify(ctx.action);
      stageResults.push(nliResult);
      if (!nliResult.passed) {
        reasons.push(nliResult.reason);
        return {
          allowed: false,
          confidence: nliResult.confidence,
          stageResults,
          reasons,
          durationMs: Date.now() - start,
        };
      }
    }

    // All stages passed (or were skipped)
    const minConfidence = stageResults.length > 0
      ? Math.min(...stageResults.filter((r) => r.passed).map((r) => r.confidence))
      : 1.0;

    return {
      allowed: true,
      confidence: minConfidence,
      stageResults,
      reasons: [],
      durationMs: Date.now() - start,
    };
  }
}
