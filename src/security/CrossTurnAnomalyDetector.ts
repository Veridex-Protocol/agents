/**
 * @packageDocumentation
 * @module CrossTurnAnomalyBaseline
 * @description
 * Maintains a sliding window of tool-call distributions per session
 * and flags statistical deviations — e.g., sudden appearance of
 * `Bash` tool after 50 turns of only `Read`/`Edit`.
 *
 * Addresses AC-1.b (conditional delivery) from "Your Agent Is Mine":
 * - Routers may behave honestly for N requests then activate malicious payloads
 * - Per-response guards evaluate independently and miss this pattern
 * - This module compares ACROSS turns to detect behavioral drift
 *
 * Designed as an afterModelCall + beforeToolExecute hook pair.
 */

import type { RuntimeHook, HookResult } from '../types/hooks';
import type { SecurityPolicyPack } from './types';

// ── Types ──

export interface ToolDistribution {
  /** Tool name → call count in this window */
  toolCounts: Map<string, number>;
  /** Total tool calls in this window */
  totalCalls: number;
  /** Turn indices covered */
  turnRange: [number, number];
}

export interface AnomalySignal {
  type: 'new_tool_emergence' | 'distribution_shift' | 'frequency_spike' | 'tool_class_escalation';
  severity: 'critical' | 'high' | 'medium';
  description: string;
  evidence: Record<string, unknown>;
}

export interface SessionBaseline {
  /** Session/run identifier */
  sessionId: string;
  /** All tool calls observed, in order */
  history: Array<{
    turnIndex: number;
    toolName: string;
    safetyClass: string;
    timestamp: number;
  }>;
  /** Sliding window baseline distribution */
  baseline: ToolDistribution;
  /** Current window distribution (most recent calls) */
  current: ToolDistribution;
  /** Detected anomalies */
  anomalies: AnomalySignal[];
}

export interface CrossTurnAnomalyConfig {
  /** Baseline window size in turns (default: 20). */
  baselineWindowTurns?: number;
  /** Current window size in turns for comparison (default: 5). */
  currentWindowTurns?: number;
  /** Minimum turns before enabling anomaly detection (default: 10). */
  warmupTurns?: number;
  /** High-risk tool names that trigger immediate alert when first seen late in session. */
  highRiskTools?: string[];
  /** High-risk safety classes that escalate severity. */
  highRiskClasses?: string[];
  /** Chi-squared threshold for distribution shift detection (default: 0.05). */
  distributionAlpha?: number;
  /** Tool call frequency spike multiplier (default: 3x). */
  frequencySpikeFactor?: number;
}

// ── Defaults ──

const DEFAULT_HIGH_RISK_TOOLS = new Set([
  'bash', 'Bash', 'shell', 'Shell', 'run_command', 'RunCommand',
  'execute', 'Execute', 'terminal', 'Terminal', 'exec', 'Exec',
  'write_file', 'WriteFile', 'delete_file', 'DeleteFile',
  'http_request', 'HttpRequest', 'fetch', 'Fetch',
]);

const DEFAULT_HIGH_RISK_CLASSES = new Set([
  'financial', 'destructive', 'privileged', 'network', 'filesystem',
]);

// ── Chi-squared approximation (simplified, 2-tail) ──

/**
 * Simplified chi-squared test for comparing two tool distributions.
 * Returns a p-value approximation. Lower p = more different distributions.
 */
function chiSquaredTest(
  observed: Map<string, number>,
  expected: Map<string, number>,
  totalObserved: number,
  totalExpected: number,
): number {
  if (totalObserved === 0 || totalExpected === 0) return 1.0;

  const allTools = new Set([...observed.keys(), ...expected.keys()]);
  let chiSq = 0;
  const df = Math.max(allTools.size - 1, 1);

  for (const tool of allTools) {
    const obs = observed.get(tool) ?? 0;
    const expCount = (expected.get(tool) ?? 0) * (totalObserved / totalExpected);
    const exp = Math.max(expCount, 0.5); // Avoid division by zero
    chiSq += ((obs - exp) ** 2) / exp;
  }

  // Approximate p-value using Wilson-Hilferty approximation
  const z = Math.cbrt(chiSq / df) - (1 - 2 / (9 * df));
  const denom = Math.sqrt(2 / (9 * df));
  const approxZ = z / (denom || 1);

  // Standard normal CDF approximation
  const p = 1 - 0.5 * (1 + erf(approxZ / Math.SQRT2));
  return Math.max(0, Math.min(1, p));
}

/** Error function approximation (Abramowitz and Stegun). */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

// ── Implementation ──

export class CrossTurnAnomalyDetector {
  private readonly config: Required<CrossTurnAnomalyConfig>;
  private readonly sessions = new Map<string, SessionBaseline>();

  constructor(config?: CrossTurnAnomalyConfig) {
    this.config = {
      baselineWindowTurns: config?.baselineWindowTurns ?? 20,
      currentWindowTurns: config?.currentWindowTurns ?? 5,
      warmupTurns: config?.warmupTurns ?? 10,
      highRiskTools: config?.highRiskTools ?? [...DEFAULT_HIGH_RISK_TOOLS],
      highRiskClasses: config?.highRiskClasses ?? [...DEFAULT_HIGH_RISK_CLASSES],
      distributionAlpha: config?.distributionAlpha ?? 0.05,
      frequencySpikeFactor: config?.frequencySpikeFactor ?? 3,
    };
  }

  private highRiskToolSet = new Set<string>();
  private highRiskClassSet = new Set<string>();

  private ensureSets(): void {
    if (this.highRiskToolSet.size === 0) {
      this.highRiskToolSet = new Set(this.config.highRiskTools);
      this.highRiskClassSet = new Set(this.config.highRiskClasses);
    }
  }

  /**
   * Record a tool call observation for a session.
   */
  observe(sessionId: string, toolName: string, safetyClass: string, turnIndex: number): AnomalySignal[] {
    this.ensureSets();

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        history: [],
        baseline: { toolCounts: new Map(), totalCalls: 0, turnRange: [0, 0] },
        current: { toolCounts: new Map(), totalCalls: 0, turnRange: [0, 0] },
        anomalies: [],
      };
      this.sessions.set(sessionId, session);
    }

    // Record observation
    session.history.push({
      turnIndex,
      toolName,
      safetyClass,
      timestamp: Date.now(),
    });

    // Not enough data yet
    if (session.history.length < this.config.warmupTurns) {
      return [];
    }

    // Recompute windows
    const allTurns = session.history;
    const baselineEnd = allTurns.length - this.config.currentWindowTurns;
    const baselineStart = Math.max(0, baselineEnd - this.config.baselineWindowTurns);

    if (baselineEnd <= baselineStart) return [];

    // Build baseline distribution
    const baselineCounts = new Map<string, number>();
    let baselineTotal = 0;
    for (let i = baselineStart; i < baselineEnd; i++) {
      const t = allTurns[i].toolName;
      baselineCounts.set(t, (baselineCounts.get(t) ?? 0) + 1);
      baselineTotal++;
    }

    // Build current distribution
    const currentCounts = new Map<string, number>();
    let currentTotal = 0;
    for (let i = baselineEnd; i < allTurns.length; i++) {
      const t = allTurns[i].toolName;
      currentCounts.set(t, (currentCounts.get(t) ?? 0) + 1);
      currentTotal++;
    }

    session.baseline = {
      toolCounts: baselineCounts,
      totalCalls: baselineTotal,
      turnRange: [baselineStart, baselineEnd - 1],
    };
    session.current = {
      toolCounts: currentCounts,
      totalCalls: currentTotal,
      turnRange: [baselineEnd, allTurns.length - 1],
    };

    // Run anomaly checks
    const newAnomalies: AnomalySignal[] = [];

    // 1. New tool emergence — tool appears in current but not in baseline
    for (const [tool, count] of currentCounts) {
      if (!baselineCounts.has(tool) && count > 0) {
        const isHighRisk = this.highRiskToolSet.has(tool);
        newAnomalies.push({
          type: 'new_tool_emergence',
          severity: isHighRisk ? 'critical' : 'medium',
          description: `Tool '${tool}' appeared for the first time after ${baselineTotal} baseline calls${isHighRisk ? ' (HIGH-RISK TOOL)' : ''}`,
          evidence: {
            tool,
            firstSeenTurn: turnIndex,
            baselineTurns: baselineTotal,
            isHighRisk,
          },
        });
      }
    }

    // 2. Distribution shift (chi-squared)
    const pValue = chiSquaredTest(currentCounts, baselineCounts, currentTotal, baselineTotal);
    if (pValue < this.config.distributionAlpha) {
      newAnomalies.push({
        type: 'distribution_shift',
        severity: 'high',
        description: `Tool usage distribution shifted significantly (p=${pValue.toFixed(4)}, α=${this.config.distributionAlpha})`,
        evidence: {
          pValue,
          baselineDistribution: Object.fromEntries(baselineCounts),
          currentDistribution: Object.fromEntries(currentCounts),
        },
      });
    }

    // 3. Frequency spike — tool called N times more than baseline average
    for (const [tool, count] of currentCounts) {
      const baselineCount = baselineCounts.get(tool) ?? 0;
      const baselineRate = baselineCount / Math.max(baselineTotal, 1);
      const currentRate = count / Math.max(currentTotal, 1);
      if (baselineRate > 0 && currentRate > baselineRate * this.config.frequencySpikeFactor) {
        newAnomalies.push({
          type: 'frequency_spike',
          severity: 'high',
          description: `Tool '${tool}' frequency spiked: ${(currentRate * 100).toFixed(0)}% vs baseline ${(baselineRate * 100).toFixed(0)}%`,
          evidence: { tool, currentRate, baselineRate, factor: currentRate / baselineRate },
        });
      }
    }

    // 4. Tool class escalation — high-risk class appearing when not seen in baseline
    const baselineClasses = new Set(
      allTurns.slice(baselineStart, baselineEnd).map((t) => t.safetyClass),
    );
    if (this.highRiskClassSet.has(safetyClass) && !baselineClasses.has(safetyClass)) {
      newAnomalies.push({
        type: 'tool_class_escalation',
        severity: 'critical',
        description: `Safety class '${safetyClass}' appeared for the first time after ${baselineTotal} baseline calls`,
        evidence: {
          safetyClass,
          firstSeenTurn: turnIndex,
          baselineClasses: [...baselineClasses],
        },
      });
    }

    session.anomalies.push(...newAnomalies);
    return newAnomalies;
  }

  /** Get session baseline data. */
  getSession(sessionId: string): SessionBaseline | undefined {
    return this.sessions.get(sessionId);
  }

  /** Get all sessions. */
  getSessions(): ReadonlyArray<SessionBaseline> {
    return [...this.sessions.values()];
  }

  /** Clear a session. */
  clearSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Clear all sessions. */
  clearAll(): void {
    this.sessions.clear();
  }
}

// ── Security Policy Pack ──

export interface CrossTurnAnomalyPackOptions {
  /** Baseline window size in turns (default: 20). */
  baselineWindowTurns?: number;
  /** Current window size for comparison (default: 5). */
  currentWindowTurns?: number;
  /** Warmup turns before detection (default: 10). */
  warmupTurns?: number;
  /** Additional high-risk tool names. */
  additionalHighRiskTools?: string[];
  /** Block on critical anomalies (default: true). */
  blockOnCritical?: boolean;
}

/**
 * Creates a cross-turn anomaly baseline security pack.
 *
 * Monitors tool-call patterns across turns and flags deviations
 * from the session baseline — catches conditional delivery attacks.
 */
export function crossTurnAnomalyPack(opts?: CrossTurnAnomalyPackOptions): SecurityPolicyPack {
  const blockOnCritical = opts?.blockOnCritical ?? true;
  const detector = new CrossTurnAnomalyDetector({
    baselineWindowTurns: opts?.baselineWindowTurns,
    currentWindowTurns: opts?.currentWindowTurns,
    warmupTurns: opts?.warmupTurns,
    highRiskTools: opts?.additionalHighRiskTools
      ? [...DEFAULT_HIGH_RISK_TOOLS, ...opts.additionalHighRiskTools]
      : undefined,
  });

  const hook: RuntimeHook = {
    name: 'security:cross-turn-anomaly',
    phase: 'beforeToolExecute',
    priority: 6,
    execute(ctx: unknown): HookResult | void {
      const hookCtx = ctx as {
        runId?: string;
        agentId?: string;
        turnIndex?: number;
        toolName?: string;
        safetyClass?: string;
      };

      if (!hookCtx.toolName || !hookCtx.runId) return;

      const sessionId = hookCtx.runId;
      const signals = detector.observe(
        sessionId,
        hookCtx.toolName,
        hookCtx.safetyClass ?? 'unknown',
        hookCtx.turnIndex ?? 0,
      );

      if (signals.length === 0) return;

      const hasCritical = signals.some((s) => s.severity === 'critical');
      const hasHigh = signals.some((s) => s.severity === 'high');

      const descriptions = signals.map((s) => s.description).join('; ');

      if (hasCritical && blockOnCritical) {
        return {
          override: 'deny',
          reason: `Cross-turn anomaly detected: ${descriptions}`,
          annotations: {
            crossTurnAnomaly: true,
            signals: signals.map((s) => ({
              type: s.type,
              severity: s.severity,
              description: s.description,
            })),
          },
        };
      }

      if (hasHigh) {
        return {
          override: 'pause',
          reason: `Cross-turn anomaly warning: ${descriptions}`,
          annotations: {
            crossTurnAnomaly: true,
            signals: signals.map((s) => ({
              type: s.type,
              severity: s.severity,
              description: s.description,
            })),
          },
        };
      }

      return {
        annotations: {
          crossTurnAnomaly: true,
          signals: signals.map((s) => ({
            type: s.type,
            severity: s.severity,
            description: s.description,
          })),
        },
      };
    },
  };

  return {
    id: 'security:cross-turn-anomaly',
    name: 'Cross-Turn Anomaly Baseline',
    description: 'Maintains sliding-window tool-call distributions per session and flags deviations. Catches conditional delivery attacks (AC-1.b).',
    version: '1.0.0',
    rules: [],
    hooks: [hook],
  };
}
