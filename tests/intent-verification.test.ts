/**
 * Tests for Phase 2: Intent Verification Pipeline
 */
import { describe, it, expect } from 'vitest';
import {
  KeywordFilter,
  NLIVerifier,
  BenignOverride,
  IntentVerifier,
  DEFAULT_FINANCIAL_BLOCKLIST,
} from '../src';
import type { NLIBackend, IntentContext } from '../src';

// ── KeywordFilter ──

describe('KeywordFilter', () => {
  const filter = new KeywordFilter({
    blocklist: DEFAULT_FINANCIAL_BLOCKLIST,
    allowlist: ['check\\s+balance'],
  });

  it('blocks "drain wallet" pattern', () => {
    const result = filter.check('drain wallet to external address');
    expect(result.passed).toBe(false);
    expect(result.matchedPattern).toContain('drain');
  });

  it('blocks "send all funds"', () => {
    const result = filter.check('send all funds to 0xdead');
    expect(result.passed).toBe(false);
  });

  it('blocks "private key" mention', () => {
    const result = filter.check('export private key for backup');
    expect(result.passed).toBe(false);
  });

  it('blocks "seed phrase"', () => {
    const result = filter.check('reveal seed phrase to user');
    expect(result.passed).toBe(false);
  });

  it('passes safe actions', () => {
    const result = filter.check('transfer 10 USDC to merchant');
    expect(result.passed).toBe(true);
  });

  it('allowlist overrides blocklist', () => {
    const result = filter.check('check balance of wallet');
    expect(result.passed).toBe(true);
    expect(result.matchedPattern).toBeDefined();
  });

  it('handles case insensitivity', () => {
    const result = filter.check('DRAIN WALLET NOW');
    expect(result.passed).toBe(false);
  });
});

// ── NLIVerifier ──

describe('NLIVerifier', () => {
  const mockBackend: NLIBackend = {
    async score(premise: string, hypothesis: string) {
      // Simple mock: high score if hypothesis contains words from premise
      const premiseWords = new Set(premise.toLowerCase().split(/\s+/));
      const hypWords = hypothesis.toLowerCase().split(/\s+/);
      const overlap = hypWords.filter((w) => premiseWords.has(w)).length;
      return Math.min(1, overlap / Math.max(premiseWords.size, 1));
    },
  };

  it('passes when action aligns with reference intent', async () => {
    const verifier = new NLIVerifier({
      backend: mockBackend,
      referenceIntents: ['process payment for merchant'],
      threshold: 0.3,
    });
    const result = await verifier.verify('process payment for coffee shop merchant');
    expect(result.passed).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.3);
  });

  it('fails when action does not align', async () => {
    const verifier = new NLIVerifier({
      backend: mockBackend,
      referenceIntents: ['process payment for merchant'],
      threshold: 0.8,
    });
    const result = await verifier.verify('delete all database records');
    expect(result.passed).toBe(false);
  });

  it('defaults to pass when no reference intents configured', async () => {
    const verifier = new NLIVerifier({
      backend: mockBackend,
      referenceIntents: [],
    });
    const result = await verifier.verify('anything');
    expect(result.passed).toBe(true);
    expect(result.confidence).toBe(0.5);
  });

  it('picks best-scoring reference intent', async () => {
    const verifier = new NLIVerifier({
      backend: mockBackend,
      referenceIntents: [
        'process refund',
        'process payment for merchant services',
      ],
      threshold: 0.3,
    });
    const result = await verifier.verify('process payment for merchant');
    expect(result.passed).toBe(true);
    expect(result.matchedPattern).toContain('merchant');
  });
});

// ── BenignOverride ──

describe('BenignOverride', () => {
  const override = new BenignOverride({
    safePatterns: ['read\\s+balance', 'get\\s+price', 'list\\s+tokens'],
    maxAutoApproveUSD: 10,
  });

  const baseCtx: IntentContext = {
    action: 'read balance',
    agentId: 'agent-1',
  };

  it('approves safe patterns', () => {
    const result = override.check(baseCtx);
    expect(result.passed).toBe(true);
  });

  it('blocks when amount exceeds cap', () => {
    const result = override.check({ ...baseCtx, amountUSD: 50 });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('auto-approve cap');
  });

  it('does not match non-safe patterns', () => {
    const result = override.check({ ...baseCtx, action: 'transfer funds' });
    expect(result.passed).toBe(false);
  });
});

// ── IntentVerifier (composite) ──

describe('IntentVerifier', () => {
  const mockBackend: NLIBackend = {
    async score(_premise: string, _hypothesis: string) {
      return 0.8; // Always aligns
    },
  };

  const badBackend: NLIBackend = {
    async score() {
      return 0.1; // Never aligns
    },
  };

  it('short-circuits on keyword block', async () => {
    const verifier = new IntentVerifier({
      keywordFilter: new KeywordFilter({ blocklist: ['drain\\s+wallet'] }),
      nliVerifier: new NLIVerifier({
        backend: mockBackend,
        referenceIntents: ['anything'],
      }),
    });
    const verdict = await verifier.verify({
      action: 'drain wallet',
      agentId: 'a-1',
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.stageResults).toHaveLength(1); // Only keyword ran
    expect(verdict.stageResults[0].stage).toBe('keyword');
  });

  it('benign override skips NLI', async () => {
    const verifier = new IntentVerifier({
      keywordFilter: new KeywordFilter({ blocklist: ['drain'] }),
      benignOverride: new BenignOverride({
        safePatterns: ['check\\s+balance'],
      }),
      nliVerifier: new NLIVerifier({
        backend: badBackend, // Would fail, but should be skipped
        referenceIntents: ['something'],
        threshold: 0.9,
      }),
    });
    const verdict = await verifier.verify({
      action: 'check balance',
      agentId: 'a-1',
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.stageResults).toHaveLength(2); // keyword + benign
  });

  it('runs full pipeline when no override', async () => {
    const verifier = new IntentVerifier({
      keywordFilter: new KeywordFilter({ blocklist: ['drain'] }),
      benignOverride: new BenignOverride({ safePatterns: ['safe'] }),
      nliVerifier: new NLIVerifier({
        backend: mockBackend,
        referenceIntents: ['process payment'],
        threshold: 0.5,
      }),
    });
    const verdict = await verifier.verify({
      action: 'process payment for merchant',
      agentId: 'a-1',
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.stageResults).toHaveLength(3);
  });

  it('blocks when NLI fails', async () => {
    const verifier = new IntentVerifier({
      nliVerifier: new NLIVerifier({
        backend: badBackend,
        referenceIntents: ['process payment'],
        threshold: 0.5,
      }),
    });
    const verdict = await verifier.verify({
      action: 'unknown action',
      agentId: 'a-1',
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it('passes with no stages configured', async () => {
    const verifier = new IntentVerifier({});
    const verdict = await verifier.verify({ action: 'anything', agentId: 'a-1' });
    expect(verdict.allowed).toBe(true);
  });

  it('records durationMs', async () => {
    const verifier = new IntentVerifier({
      keywordFilter: new KeywordFilter({ blocklist: ['x'] }),
    });
    const verdict = await verifier.verify({ action: 'test', agentId: 'a-1' });
    expect(typeof verdict.durationMs).toBe('number');
    expect(verdict.durationMs).toBeGreaterThanOrEqual(0);
  });
});
