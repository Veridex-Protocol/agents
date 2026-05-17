/**
 * @packageDocumentation
 * @module RuntimeGuards
 * @description
 * Lightweight guard contracts the {@link AgentRuntime} depends on.
 *
 * Historically the runtime hard-imported `LLMResponseGuard` and
 * `SupplyChainGuard` from `@veridex/agentic-payments`. That coupled core to a
 * payments package and prevented users from running the runtime without it.
 *
 * The interfaces below capture the minimum surface the runtime needs. Default
 * no-op implementations let the runtime boot cleanly without any payments
 * dependency. The real guards can be supplied via runtime options or a
 * {@link RuntimePlugin} that wires them in at install time.
 */

import { randomBytes } from 'node:crypto';

/** Proposal shape consumed by {@link LLMResponseGuard.validate}. */
export interface GuardToolCallProposal {
  name: string;
  arguments: Record<string, unknown>;
}

/** A single guard violation. */
export interface GuardViolation {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  detail: string;
}

/** Result returned by {@link LLMResponseGuard.validate}. */
export interface LLMResponseValidation {
  safe: boolean;
  violations: GuardViolation[];
  riskScore?: number;
}

/** Validates model output + proposed tool calls before execution. */
export interface LLMResponseGuard {
  validate(responseText: string, toolCalls: GuardToolCallProposal[]): LLMResponseValidation;
}

/** Single issue surfaced by the supply chain guard. */
export interface SupplyChainIssue {
  severity: 'low' | 'medium' | 'high' | 'critical';
  detail: string;
  source?: string;
}

/** Result returned by {@link SupplyChainGuard.verifyEnvironment}. */
export interface SupplyChainCheck {
  safe: boolean;
  issues: SupplyChainIssue[];
}

/** Verifies the runtime environment for supply-chain tampering at startup. */
export interface SupplyChainGuard {
  verifyEnvironment(): SupplyChainCheck;
}

// ── Default no-op implementations ──

export class NoopLLMResponseGuard implements LLMResponseGuard {
  validate(): LLMResponseValidation {
    return { safe: true, violations: [] };
  }
}

export class NoopSupplyChainGuard implements SupplyChainGuard {
  verifyEnvironment(): SupplyChainCheck {
    return { safe: true, issues: [] };
  }
}

/** Generate a canary token suitable for prompt-leak detection. */
export function generateCanaryToken(): string {
  return `VRDX-CANARY-${randomBytes(8).toString('hex').toUpperCase()}`;
}
