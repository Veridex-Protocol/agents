/**
 * @packageDocumentation
 * @module PaymentsAdapter
 * @description
 * Adapter bridging @veridex/agentic-payments into the agent runtime.
 * Wraps payment operations as tool-compatible, policy-aware functions.
 * Works only when @veridex/agentic-payments is installed as a peer dependency.
 */

export interface PaymentsAdapterConfig {
  /** Agentic payments instance */
  payments: unknown;
  /** Budget limits */
  budgetLimits?: {
    maxPerTransaction?: number;
    maxPerRun?: number;
    maxPerDay?: number;
  };
}

export class PaymentsAdapter {
  private payments: unknown;
  private budgetLimits: PaymentsAdapterConfig['budgetLimits'];
  private runSpend = 0;

  constructor(config: PaymentsAdapterConfig) {
    this.payments = config.payments;
    this.budgetLimits = config.budgetLimits;
  }

  /** Check if payments subsystem is available. */
  isAvailable(): boolean {
    return this.payments != null;
  }

  /** Get the underlying payments instance (typed by consumer). */
  getPayments<T = unknown>(): T {
    if (!this.payments) throw new Error('Veridex Payments not available');
    return this.payments as T;
  }

  /** Check if a transaction amount is within budget limits. */
  checkBudget(amount: number): { allowed: boolean; reason?: string } {
    if (this.budgetLimits?.maxPerTransaction && amount > this.budgetLimits.maxPerTransaction) {
      return {
        allowed: false,
        reason: `Amount $${amount} exceeds per-transaction limit of $${this.budgetLimits.maxPerTransaction}`,
      };
    }

    if (this.budgetLimits?.maxPerRun && this.runSpend + amount > this.budgetLimits.maxPerRun) {
      return {
        allowed: false,
        reason: `Amount $${amount} would exceed run budget ($${this.runSpend}/$${this.budgetLimits.maxPerRun} spent)`,
      };
    }

    return { allowed: true };
  }

  /** Record a spend event. */
  recordSpend(amount: number): void {
    this.runSpend += amount;
  }

  /** Get total spend for the current run. */
  getRunSpend(): number {
    return this.runSpend;
  }

  /** Reset run spend tracking (for new runs). */
  resetRunSpend(): void {
    this.runSpend = 0;
  }
}
