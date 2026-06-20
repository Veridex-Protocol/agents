/**
 * @packageDocumentation
 * @module SecurityGatewayPlugin
 * @description
 * Optional {@link RuntimePlugin} that bridges the framework-agnostic
 * {@link SecurityGateway} from `@veridex/agent-security` into the
 * {@link AgentRuntime}'s policy engine.
 *
 * This is the **canonical** way to use cross-framework security packs from
 * within the runtime. The 14 runtime-native packs in
 * `@veridex/agents/security` remain available for runtime-specific use cases
 * (custom hook/policy compositions). The gateway is preferred for new code:
 *
 * - **`@veridex/agent-security`** — canonical home for framework-agnostic
 *   detection packs (LangChain / CrewAI / AutoGPT / Veridex).
 * - **`@veridex/agents/security`** — runtime-native `SecurityPolicyPack`s for
 *   custom hook-based compositions.
 *
 * The gateway is loaded via `require()` so `@veridex/agents` keeps zero
 * static dependency on the security package.
 */

import type { RuntimePlugin, RuntimePluginContext } from '../runtime/RuntimePlugin';
import type { PolicyContext } from '../policy/PolicyEngine';
import type { PolicyCheckResult } from '../types/policy';

/** Subset of @veridex/agent-security types we depend on at runtime. */
interface GatewaySecurityAction {
  type: string;
  toolCalls?: Array<{ name: string; description?: string; arguments: Record<string, unknown> }>;
  content?: string;
  endpoint?: string;
  targetAgentId?: string;
  amountUsd?: number;
  metadata?: Record<string, unknown>;
}
interface GatewayEvalContext {
  agent: { agentId: string; framework?: string };
  action: GatewaySecurityAction;
  runId?: string;
  turnIndex?: number;
  runSpendUsd?: number;
  totalTokens?: number;
  timestamp?: number;
}
interface GatewayEvalResult {
  verdict: 'pass' | 'flag' | 'escalate' | 'block';
  riskScore: number;
  reasons: string[];
}
interface GatewayLike {
  evaluate(ctx: GatewayEvalContext): Promise<GatewayEvalResult>;
}

export interface SecurityGatewayPluginOptions {
  /**
   * Pre-built gateway instance. If omitted, the plugin will construct a
   * default `SecurityGateway` from `@veridex/agent-security`.
   */
  gateway?: GatewayLike;
  /** Forwarded to the gateway constructor when `gateway` is not provided. */
  gatewayConfig?: Record<string, unknown>;
  /** Framework tag passed to the gateway (default: `'veridex'`). */
  framework?: string;
  /** Priority of the bridged policy rule (default: 100). */
  priority?: number;
}

/**
 * Build a runtime plugin that registers a single PolicyRule which delegates
 * to a `SecurityGateway`. Tool-call proposals are converted to the gateway's
 * `SecurityEvalContext` shape and the gateway's verdict is returned as a
 * `PolicyCheckResult`.
 *
 * @example
 * ```ts
 * import { createAgent } from '@veridex/agents';
 * import { securityGatewayPlugin } from '@veridex/agents/integrations';
 *
 * const agent = createAgent(definition, {
 *   plugins: [securityGatewayPlugin()],
 * });
 * ```
 */
export function securityGatewayPlugin(
  options: SecurityGatewayPluginOptions = {},
): RuntimePlugin {
  return {
    id: 'veridex.security-gateway',
    install(ctx: RuntimePluginContext): void {
      let gateway = options.gateway;
      if (!gateway) {
        let mod: typeof import('@veridex/agent-security');
        try {
          // Dynamic require keeps `@veridex/agent-security` out of the static
          // import graph.
          // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
          mod = require('@veridex/agent-security');
        } catch (err) {
          throw new Error(
            `[securityGatewayPlugin] @veridex/agent-security is not installed. ${(err as Error).message}`,
          );
        }
        gateway = new mod.SecurityGateway(options.gatewayConfig) as unknown as GatewayLike;
      }

      const framework = options.framework ?? 'veridex';
      const priority = options.priority ?? 100;

      ctx.registerPolicy({
        id: 'veridex.security-gateway:bridge',
        name: 'Security Gateway Bridge',
        description:
          'Delegates tool-call validation to the framework-agnostic @veridex/agent-security gateway.',
        priority,
        async evaluate(policyCtx: PolicyContext): Promise<PolicyCheckResult> {
          // Only tool-call proposals are bridged; other proposals pass through.
          if (policyCtx.proposal.type !== 'tool_call') {
            return {
              ruleId: 'veridex.security-gateway:bridge',
              ruleName: 'Security Gateway Bridge',
              passed: true,
              verdict: 'pass',
              reason: 'Not a tool call',
              riskContribution: 0,
            };
          }

          const evalCtx: GatewayEvalContext = {
            agent: { agentId: policyCtx.agentId, framework },
            action: {
              type: 'tool_call',
              toolCalls: policyCtx.proposal.toolCalls.map((tc) => ({
                name: tc.name,
                arguments: (tc.arguments ?? {}) as Record<string, unknown>,
              })),
            },
            runId: policyCtx.runId,
            turnIndex: policyCtx.turnIndex,
            runSpendUsd: policyCtx.runSpendUSD,
            totalTokens: policyCtx.totalTokens,
            timestamp: Date.now(),
          };

          const result = await gateway?.evaluate(evalCtx);
          return {
            ruleId: 'veridex.security-gateway:bridge',
            ruleName: 'Security Gateway Bridge',
            passed: result.verdict === 'pass',
            verdict: result.verdict,
            reason:
              result.reasons.length > 0
                ? result.reasons.join('; ')
                : `Gateway verdict: ${result.verdict}`,
            riskContribution: result.riskScore,
          };
        },
      });
    },
  };
}
