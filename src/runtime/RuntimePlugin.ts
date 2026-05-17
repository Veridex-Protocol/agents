/**
 * @packageDocumentation
 * @module RuntimePlugin
 * @description
 * Plugin contract that lets external packages extend the {@link AgentRuntime}
 * without the runtime hard-importing them. Plugins install during runtime
 * construction and may swap guards, register policy rules, append tools, or
 * subscribe to hooks.
 *
 * The contract is intentionally small. Each plugin receives a typed
 * {@link RuntimePluginContext} that exposes only the surface area it is
 * allowed to mutate.
 */

import type { LLMResponseGuard, SupplyChainGuard } from './guards';
import type { ToolContract } from '../types/tools';
import type { RuntimeHook } from '../types/hooks';
import type { PolicyRule } from '../policy/PolicyEngine';

/** Limited surface a plugin may mutate during installation. */
export interface RuntimePluginContext {
  /** Replace the runtime's LLM response guard. */
  setLLMResponseGuard(guard: LLMResponseGuard): void;
  /** Replace the runtime's supply chain guard. */
  setSupplyChainGuard(guard: SupplyChainGuard): void;
  /** Register an additional tool. Idempotent on tool name. */
  registerTool(tool: ToolContract): void;
  /** Register an additional runtime hook. */
  registerHook(hook: RuntimeHook): void;
  /** Register an additional policy rule. */
  registerPolicy(rule: PolicyRule): void;
  /** Stable identity of the runtime for the plugin's bookkeeping. */
  readonly agentId: string;
  /** Canary token currently in use; plugins may reuse it. */
  readonly canaryToken: string;
}

/** Anything pluggable into the runtime. */
export interface RuntimePlugin {
  /** Stable identifier used in logs and disposal. */
  readonly id: string;
  /**
   * Install the plugin. Called once during runtime construction. Plugins
   * should be idempotent — `install` may be invoked again after a restore.
   */
  install(ctx: RuntimePluginContext): void;
  /** Optional cleanup hook. The runtime invokes this on shutdown. */
  dispose?(): void;
}
