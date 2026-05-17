/**
 * @packageDocumentation
 * @module PaymentsGuardsPlugin
 * @description
 * Optional {@link RuntimePlugin} that wires the real `LLMResponseGuard` and
 * `SupplyChainGuard` implementations from `@veridex/agentic-payments` into an
 * {@link AgentRuntime}.
 *
 * Core runtime defaults to no-op guards (see `src/runtime/guards.ts`) so it has
 * **zero hard dependency** on the payments package. Applications that ship
 * with payments enabled construct this plugin and pass it via
 * `createAgent({ plugins: [paymentsGuardsPlugin(...)] })`.
 *
 * The plugin lazily imports `@veridex/agentic-payments` so that the symbol
 * never appears in the runtime's static dependency graph. If the package is
 * not installed, `install()` throws with a clear message.
 */

import type { RuntimePlugin, RuntimePluginContext } from '../runtime/RuntimePlugin';
import type {
  LLMResponseGuard,
  SupplyChainGuard,
  GuardToolCallProposal,
  LLMResponseValidation,
  SupplyChainCheck,
} from '../runtime/guards';

export interface PaymentsGuardsPluginOptions {
  /** Pre-shared canary token. Defaults to the runtime's canary. */
  canaryToken?: string;
  /** Whitelist of addresses the agent may transact with. */
  allowedAddresses?: Set<string>;
  /** Whitelist of tool names the agent may invoke. */
  knownTools?: Set<string>;
  /** Cap on financial actions per turn. */
  maxFinancialActionsPerTurn?: number;
  /** Skip installing the supply-chain guard (LLM guard only). */
  skipSupplyChainGuard?: boolean;
}

/**
 * Build a runtime plugin that installs the real payments-aware guards.
 *
 * @example
 * ```ts
 * import { createAgent } from '@veridex/agents';
 * import { paymentsGuardsPlugin } from '@veridex/agents/integrations/PaymentsGuardsPlugin';
 *
 * const agent = createAgent(definition, {
 *   plugins: [paymentsGuardsPlugin({ allowedAddresses: new Set([...]) })],
 * });
 * ```
 */
export function paymentsGuardsPlugin(
  options: PaymentsGuardsPluginOptions = {},
): RuntimePlugin {
  return {
    id: 'veridex.payments-guards',
    install(ctx: RuntimePluginContext): void {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      let payments: typeof import('@veridex/agentic-payments');
      try {
        // Dynamic require keeps `@veridex/agentic-payments` out of the
        // runtime's static import graph.
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        payments = require('@veridex/agentic-payments');
      } catch (err) {
        throw new Error(
          `[paymentsGuardsPlugin] @veridex/agentic-payments is not installed. ${(err as Error).message}`,
        );
      }

      const llmGuard = new payments.LLMResponseGuard({
        canaryToken: options.canaryToken ?? ctx.canaryToken,
        maxFinancialActionsPerTurn: options.maxFinancialActionsPerTurn ?? 3,
        allowedAddresses: options.allowedAddresses,
        knownTools: options.knownTools,
      });
      // Adapt to the local contract — the shapes match by construction.
      ctx.setLLMResponseGuard({
        validate(text: string, toolCalls: GuardToolCallProposal[]): LLMResponseValidation {
          return llmGuard.validate(text, toolCalls) as LLMResponseValidation;
        },
      });

      if (!options.skipSupplyChainGuard) {
        const supplyGuard = new payments.SupplyChainGuard();
        ctx.setSupplyChainGuard({
          verifyEnvironment(): SupplyChainCheck {
            return supplyGuard.verifyEnvironment() as SupplyChainCheck;
          },
        });
      }
    },
  };
}
