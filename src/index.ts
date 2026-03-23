/**
 * @packageDocumentation
 * @module @veridex/agents
 * @description
 * Veridex Agent Fabric — a model-agnostic, payment-native agent runtime.
 *
 * @example
 * ```ts
 * import { createAgent, tool, OpenAIProvider } from '@veridex/agents';
 * import { z } from 'zod';
 *
 * const agent = createAgent({
 *   id: 'my-agent',
 *   name: 'My Agent',
 *   model: { provider: 'openai', model: 'gpt-4o' },
 *   instructions: 'You are a helpful assistant.',
 *   tools: [
 *     tool({
 *       name: 'greet',
 *       description: 'Greet a user',
 *       input: z.object({ name: z.string() }),
 *       safetyClass: 'read',
 *       async execute({ input }) {
 *         return { llmOutput: `Hello, ${input.name}!`, success: true };
 *       },
 *     }),
 *   ],
 * });
 *
 * const result = await agent.run('Say hello to Alice');
 * console.log(result.output);
 * ```
 */

// ── Core Runtime ──
export { AgentRuntime } from './runtime/AgentRuntime';
export { createAgent } from './runtime/createAgent';

// ── Types ──
export type {
  // Agent
  AgentDefinition,
  PaymentConfig,
  PolicyConfig,
  RuntimeOptions,
  // Runtime
  Run,
  RunState,
  Turn,
  TurnResult,
  RunResult,
  // Tools
  ToolContract,
  ToolResult,
  ToolSafetyClass,
  ToolCall,
  ToolExecuteParams,
  ToolContext,
  ToolAttachment,
  ToolMetrics,
  CostEstimate,
  // Memory
  MemoryTier,
  MemoryEntry,
  MemoryStore,
  MemoryQuery,
  MemoryWriteRequest,
  MemoryConfig,
  MemoryProvenance,
  MemoryScope,
  TierConfig,
  CompactOptions,
  CompactResult,
  // Context
  ContextSection,
  ContextSource,
  ContextPlan,
  ContextCompilerOptions,
  ContextSectionInput,
  TruncationStrategy,
  // Hooks
  HookPhase,
  RuntimeHook,
  HookResult,
  HookOverride,
  HookManifest,
  HookPermission,
  RunHookContext,
  TurnHookContext,
  ToolHookContext,
  ErrorHookContext,
  // Events
  TraceEventType,
  TraceEvent,
  // Models
  ModelConfig,
  ModelProvider,
  ModelMessage,
  ModelResponse,
  ModelUsage,
  ModelCompletionOptions,
  ModelToolDefinition,
  // Proposals
  ActionProposal,
  FinalAnswerProposal,
  ToolCallProposal,
  MemoryWriteProposal,
  HandoffProposal,
  ApprovalRequestProposal,
  // Policy
  PolicyVerdict,
  PolicyDecision,
  PolicyCheckResult,
} from './types';

// ── Events ──
export { EventBus } from './events/EventBus';
export { EventLog } from './events/EventLog';

// ── Models ──
export { OpenAIProvider } from './models/OpenAIProvider';
export type { OpenAIProviderConfig } from './models/OpenAIProvider';
export { AnthropicProvider } from './models/AnthropicProvider';
export type { AnthropicProviderConfig } from './models/AnthropicProvider';
export { ModelRegistry } from './models/ModelRegistry';

// ── Tools ──
export { ToolRegistry } from './tools/ToolRegistry';
export { ToolExecutor } from './tools/ToolExecutor';
export type { ToolExecutionResult } from './tools/ToolExecutor';
export { ToolValidator } from './tools/ToolValidator';
export { tool } from './tools/tool';
export type { ToolOptions } from './tools/tool';

// ── Hooks ──
export { HookRegistry } from './hooks/HookRegistry';
export { HookRunner } from './hooks/HookRunner';
export type { HookRunResult } from './hooks/HookRunner';

// ── Context ──
export { ContextCompiler } from './context/ContextCompiler';

// ── Memory ──
export { MemoryManager } from './memory/MemoryManager';
export { InMemoryStore } from './memory/InMemoryStore';

// ── Checkpoints ──
export { CheckpointManager, InMemoryCheckpointStore } from './checkpoints/CheckpointManager';
export type { Checkpoint, CheckpointStore } from './checkpoints/CheckpointManager';

// ── Integrations ──
export { CoreAdapter } from './integrations/CoreAdapter';
export type { CoreAdapterConfig } from './integrations/CoreAdapter';
export { PaymentsAdapter } from './integrations/PaymentsAdapter';
export type { PaymentsAdapterConfig } from './integrations/PaymentsAdapter';
