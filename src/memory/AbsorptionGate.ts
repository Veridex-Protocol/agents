/**
 * @packageDocumentation
 * @module AbsorptionGate
 * @description
 * "Absorption gate" for episodic \u2192 semantic promotion.
 *
 * Letta and related stateful-memory systems observe that not every
 * episodic memory should automatically become a long-lived semantic
 * fact: noisy, redundant, or context-bound observations would otherwise
 * poison the agent's stable belief store. The absorption gate adds a
 * **fidelity check** to {@link MemoryLifecycle.promote} so each
 * candidate is judged before being absorbed.
 *
 * Two pluggable judges are shipped:
 *
 * - {@link LLMAbsorptionGate} \u2014 wraps a caller-supplied scoring
 *   function (typically an LLM-as-judge prompt). Pure auto path.
 * - {@link ApprovalAbsorptionGate} \u2014 routes candidates through an
 *   {@link ApprovalManager} as `memory_write` proposals. Human path.
 *
 * The two can be composed via {@link CompositeAbsorptionGate}: the LLM
 * judge runs first and may escalate borderline candidates to a human
 * reviewer. Test helpers `AllowAllAbsorptionGate` /
 * `DenyAllAbsorptionGate` are exported for unit tests.
 *
 * The gate is intentionally **fail-closed**: when injected but unable
 * to render a verdict (judge throws, approval times out, etc.) the
 * candidate is denied. Promotion is reversible (re-trigger next cycle)
 * but loss of provenance is not, so the conservative default is right.
 */

import type { MemoryEntry } from '../types/memory';
import type { MemoryWriteProposal } from '../types/proposals';
import type { ApprovalManager, ApprovalRequest } from '../approvals/ApprovalManager';
import type { PolicyDecision } from '../types/policy';

/** Decision returned for a single candidate. */
export type AbsorptionVerdict = 'allow' | 'deny' | 'escalate';

/** Candidate handed to a gate for evaluation. */
export interface AbsorptionCandidate {
  /** Episodic entry under consideration. */
  entry: MemoryEntry;
  /** Tier we want to promote to (always `'semantic'` today). */
  targetTier: 'semantic';
}

/** Structured decision recorded for every candidate evaluated. */
export interface AbsorptionDecision {
  candidateId: string;
  verdict: AbsorptionVerdict;
  judge: string;
  /** Optional 0..1 confidence score the judge assigned. */
  score?: number;
  reason: string;
  decidedAt: number;
}

/** Public contract for absorption gates. */
export interface AbsorptionGate {
  /** Stable identifier (e.g. `'llm:judge-v1'`). */
  readonly id: string;
  /**
   * Evaluate candidates in batch. Implementations MUST return one
   * decision per candidate, in the same order. Implementations SHOULD
   * tolerate the empty input case.
   */
  evaluate(candidates: AbsorptionCandidate[]): Promise<AbsorptionDecision[]>;
}

// \u2500\u2500 Test helpers \u2500\u2500

/** Always allows promotion. Useful as a base layer in tests. */
export class AllowAllAbsorptionGate implements AbsorptionGate {
  readonly id = 'allow-all';
  async evaluate(candidates: AbsorptionCandidate[]): Promise<AbsorptionDecision[]> {
    const at = Date.now();
    return candidates.map((c) => ({
      candidateId: c.entry.id,
      verdict: 'allow' as const,
      judge: this.id,
      reason: 'allow-all gate',
      decidedAt: at,
    }));
  }
}

/** Always denies promotion. Useful to wire fail-closed defaults. */
export class DenyAllAbsorptionGate implements AbsorptionGate {
  readonly id = 'deny-all';
  async evaluate(candidates: AbsorptionCandidate[]): Promise<AbsorptionDecision[]> {
    const at = Date.now();
    return candidates.map((c) => ({
      candidateId: c.entry.id,
      verdict: 'deny' as const,
      judge: this.id,
      reason: 'deny-all gate',
      decidedAt: at,
    }));
  }
}

// \u2500\u2500 LLM judge \u2500\u2500

/** Single-entry judge output. */
export interface JudgeScore {
  /** Fidelity score in [0, 1] for "this is a stable fact". */
  score: number;
  /** Short rationale (logged on every decision). */
  reason: string;
}

export interface LLMAbsorptionGateOptions {
  id?: string;
  /** Caller-supplied scoring function (typically an LLM judge prompt). */
  judge: (entry: MemoryEntry) => Promise<JudgeScore> | JudgeScore;
  /** Score \u2265 this auto-allows. Defaults to `0.75`. */
  allowThreshold?: number;
  /** Score \u2264 this auto-denies. Defaults to `0.4`. */
  denyThreshold?: number;
  /**
   * What to do for scores strictly between thresholds. Defaults to
   * `'escalate'` so callers can compose with a human gate.
   */
  borderline?: 'escalate' | 'allow' | 'deny';
}

/**
 * LLM-as-judge absorption gate. Calls the configured `judge` once per
 * candidate (in parallel) and maps the score to a verdict using
 * configurable thresholds.
 */
export class LLMAbsorptionGate implements AbsorptionGate {
  readonly id: string;
  private readonly judge: LLMAbsorptionGateOptions['judge'];
  private readonly allowThreshold: number;
  private readonly denyThreshold: number;
  private readonly borderline: NonNullable<LLMAbsorptionGateOptions['borderline']>;

  constructor(options: LLMAbsorptionGateOptions) {
    this.id = options.id ?? 'llm:judge';
    this.judge = options.judge;
    this.allowThreshold = options.allowThreshold ?? 0.75;
    this.denyThreshold = options.denyThreshold ?? 0.4;
    this.borderline = options.borderline ?? 'escalate';
    if (this.allowThreshold < this.denyThreshold) {
      throw new Error(
        'LLMAbsorptionGate: allowThreshold must be >= denyThreshold',
      );
    }
  }

  async evaluate(candidates: AbsorptionCandidate[]): Promise<AbsorptionDecision[]> {
    if (candidates.length === 0) return [];
    return Promise.all(
      candidates.map(async (c) => {
        const at = Date.now();
        try {
          const result = await this.judge(c.entry);
          const score = clamp01(result.score);
          let verdict: AbsorptionVerdict;
          if (score >= this.allowThreshold) verdict = 'allow';
          else if (score <= this.denyThreshold) verdict = 'deny';
          else verdict = this.borderline;
          return {
            candidateId: c.entry.id,
            verdict,
            judge: this.id,
            score,
            reason: result.reason,
            decidedAt: at,
          } satisfies AbsorptionDecision;
        } catch (err) {
          // Fail-closed: judge errors deny the candidate this cycle.
          return {
            candidateId: c.entry.id,
            verdict: 'deny' as const,
            judge: this.id,
            reason: `judge error: ${err instanceof Error ? err.message : String(err)}`,
            decidedAt: at,
          } satisfies AbsorptionDecision;
        }
      }),
    );
  }
}

// \u2500\u2500 Approval-backed judge \u2500\u2500

export interface ApprovalAbsorptionGateOptions {
  id?: string;
  approvals: ApprovalManager;
  runId: string;
  agentId: string;
  /** Turn index attached to the approval request. Defaults to `-1`. */
  turnIndex?: number;
  /**
   * Optional policy decision attached to the approval request. Defaults
   * to a synthetic `escalate` verdict so the approval manager routes to
   * a human queue.
   */
  policyDecision?: PolicyDecision;
  /**
   * Bound the time spent awaiting human approval per candidate (ms).
   * On timeout the candidate is denied. Defaults to `60_000`.
   */
  timeoutMs?: number;
}

/**
 * Routes every candidate through the {@link ApprovalManager}. Designed
 * to be composed as the escalation branch of a {@link CompositeAbsorptionGate}.
 */
export class ApprovalAbsorptionGate implements AbsorptionGate {
  readonly id: string;
  private readonly approvals: ApprovalManager;
  private readonly runId: string;
  private readonly agentId: string;
  private readonly turnIndex: number;
  private readonly policyDecision: PolicyDecision;
  private readonly timeoutMs: number;

  constructor(options: ApprovalAbsorptionGateOptions) {
    this.id = options.id ?? 'approval:human';
    this.approvals = options.approvals;
    this.runId = options.runId;
    this.agentId = options.agentId;
    this.turnIndex = options.turnIndex ?? -1;
    this.policyDecision =
      options.policyDecision ??
      ({
        verdict: 'escalate',
        riskScore: 50,
        reasons: ['memory-promotion-absorption-gate'],
        checks: [],
        evaluatedAt: Date.now(),
      } satisfies PolicyDecision);
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async evaluate(candidates: AbsorptionCandidate[]): Promise<AbsorptionDecision[]> {
    if (candidates.length === 0) return [];
    return Promise.all(
      candidates.map(async (c) => {
        const at = Date.now();
        const proposal: MemoryWriteProposal = {
          type: 'memory_write',
          writes: [
            {
              overwriteStrategy: 'merge',
              entry: {
                tier: c.targetTier,
                content: c.entry.content,
                provenance: c.entry.provenance,
                confidence: c.entry.confidence,
                tags: [...c.entry.tags, 'absorption-promotion'],
                scope: c.entry.scope,
                kind: c.entry.kind,
                ttlMs: c.entry.ttlMs,
                metadata: {
                  ...(c.entry.metadata ?? {}),
                  absorption: {
                    candidateId: c.entry.id,
                    fromTier: c.entry.tier,
                    toTier: c.targetTier,
                  },
                },
              },
            },
          ],
        };
        try {
          const decisionPromise = this.approvals.requestApproval(
            this.runId,
            this.agentId,
            this.turnIndex,
            proposal,
            this.policyDecision,
          );
          const decision = await withTimeout(decisionPromise, this.timeoutMs);
          const verdict: AbsorptionVerdict =
            decision.approved ? 'allow' : 'deny';
          return {
            candidateId: c.entry.id,
            verdict,
            judge: this.id,
            reason:
              decision.approved
                ? `approval granted by ${decision.decidedBy ?? 'reviewer'}`
                : `approval denied: ${decision.reason ?? 'no reason given'}`,
            decidedAt: at,
          } satisfies AbsorptionDecision;
        } catch (err) {
          return {
            candidateId: c.entry.id,
            verdict: 'deny' as const,
            judge: this.id,
            reason: `approval error: ${err instanceof Error ? err.message : String(err)}`,
            decidedAt: at,
          } satisfies AbsorptionDecision;
        }
      }),
    );
  }
}

// \u2500\u2500 Composite \u2500\u2500

export interface CompositeAbsorptionGateOptions {
  id?: string;
  /** Primary gate. */
  primary: AbsorptionGate;
  /** Escalation gate used when `primary` returns `'escalate'`. */
  escalation: AbsorptionGate;
}

/**
 * Compose two gates: any candidate the primary marks `'escalate'` is
 * forwarded to the escalation gate. `'allow'` and `'deny'` are taken at
 * face value.
 */
export class CompositeAbsorptionGate implements AbsorptionGate {
  readonly id: string;
  private readonly primary: AbsorptionGate;
  private readonly escalation: AbsorptionGate;

  constructor(options: CompositeAbsorptionGateOptions) {
    this.id = options.id ?? `composite:${options.primary.id}->${options.escalation.id}`;
    this.primary = options.primary;
    this.escalation = options.escalation;
  }

  async evaluate(candidates: AbsorptionCandidate[]): Promise<AbsorptionDecision[]> {
    if (candidates.length === 0) return [];
    const primary = await this.primary.evaluate(candidates);
    const escalateIdx: number[] = [];
    const escalateCandidates: AbsorptionCandidate[] = [];
    for (let i = 0; i < primary.length; i++) {
      if (primary[i]?.verdict === 'escalate') {
        escalateIdx.push(i);
        escalateCandidates.push(candidates[i]!);
      }
    }
    if (escalateCandidates.length === 0) return primary;
    const escalated = await this.escalation.evaluate(escalateCandidates);
    const out = [...primary];
    for (let k = 0; k < escalateIdx.length; k++) {
      const i = escalateIdx[k]!;
      const inner = escalated[k]!;
      out[i] = {
        ...inner,
        candidateId: out[i]?.candidateId,
        judge: `${out[i]?.judge}->${inner.judge}`,
        reason: `${out[i]?.reason} | escalated: ${inner.reason}`,
      };
    }
    return out;
  }
}

// \u2500\u2500 helpers \u2500\u2500

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let to: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        to = setTimeout(() => reject(new Error('absorption gate timeout')), ms);
      }),
    ]);
  } finally {
    if (to) clearTimeout(to);
  }
}

// Re-export the request type for callers building custom gates.
export type { ApprovalRequest };
