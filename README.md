# @veridex/agents

TypeScript-first agent runtime for general-purpose agentic software with optional Veridex-native payments, identity, policy, and trust.

## Status

`@veridex/agents` is implemented and usable, but it is still maturing. The runtime, transports, checkpoints, approvals, and companion packages are real code, not just proposal surfaces, but some APIs may still shift as the framework hardens. If you find a mismatch between docs and behavior, please open an issue or send a fix.

## What This Package Does

Use `@veridex/agents` when you want a runtime that gives you:

- typed agent definitions
- tool execution with explicit safety classes
- memory and context compilation
- policy checks and approval routing
- checkpointing and resumable execution
- trace events and audit hooks
- MCP, ACP, and A2A transport surfaces
- optional integration with `@veridex/sdk` and `@veridex/agentic-payments`

This package is designed to work for ordinary assistants and workflows, not only commerce agents.

## Installation

```bash
npm install @veridex/agents zod
```

Install one or more model SDKs depending on the providers you want to use:

```bash
npm install openai
# or
npm install @anthropic-ai/sdk
```

## Quick Start

```ts
import { createAgent, tool, OpenAIProvider } from '@veridex/agents';
import { z } from 'zod';

const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Look up an order by id',
  input: z.object({
    orderId: z.string(),
  }),
  safetyClass: 'read',
  async execute({ input }) {
    return {
      success: true,
      llmOutput: `Order ${input.orderId} is paid and queued for fulfillment.`,
    };
  },
});

const agent = createAgent(
  {
    id: 'ops-agent',
    name: 'Operations Agent',
    model: { provider: 'openai', model: 'gpt-4o-mini' },
    instructions: 'Help internal operators quickly and accurately.',
    tools: [lookupOrder],
    maxTurns: 8,
  },
  {
    modelProviders: {
      openai: new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY,
      }),
    },
    enableTracing: true,
  },
);

const result = await agent.run('Check order ORD-1042');
console.log(result.output);
```

## Core Concepts

| Primitive | Why it exists |
|---|---|
| `AgentDefinition` | Declarative agent spec: model, instructions, tools, memory, payments, policies, hooks |
| `AgentRuntime` | The executable runtime that owns tools, memory, events, approvals, policies, and checkpoints |
| `tool(...)` | Strongly typed tool contract with explicit schema, safety class, and executor |
| `MemoryManager` | Stores and queries semantic, working, episodic, and other memory tiers |
| `ContextCompiler` | Turns instructions, memory, and other runtime context into bounded prompt context |
| `PolicyEngine` | Evaluates explicit rules before actions are allowed to continue |
| `ApprovalManager` | Suspends risky work until an approver route resolves it |
| `CheckpointManager` | Persists turn-by-turn state for recovery and approval resume |
| `EventBus` / `EventLog` | Emits first-class runtime trace events for UI, audit, and testing |
| `MCPServerTransport`, `ACPTransport`, `A2ATransport` | Exposes or consumes agents and tools across other ecosystems |

## Run Lifecycle

The runtime is built around an explicit loop:

1. `run(input, metadata?)` creates a run and emits `run_started`.
2. Hooks run at `beforeRun` and `beforeTurn`.
3. The runtime compiles bounded context from instructions, memory, and runtime state.
4. The selected model provider is called.
5. The model response becomes a proposal: final answer, tool call, handoff, memory write, or approval request.
6. Policies and hook overrides are evaluated before execution continues.
7. Tools or handoffs execute, emit trace events, and can write memory or consume budget.
8. If approval is required, the run can suspend and later resume from a checkpoint.
9. The run completes, fails, or waits for approval, and emits terminal events.

This design is intentional: it keeps state explicit and inspectable instead of hiding the loop inside framework magic.

## Important Exports

### Runtime

- `createAgent`
- `AgentRuntime`

### Models

- `OpenAIProvider`
- `AnthropicProvider`
- `ModelRegistry`

### Tools and hooks

- `tool`
- `ToolRegistry`
- `ToolExecutor`
- `ToolValidator`
- `HookRegistry`
- `HookRunner`

### Context, memory, and checkpoints

- `ContextCompiler`
- `MemoryManager`
- `InMemoryStore`
- `CheckpointManager`
- `InMemoryCheckpointStore`

### Governance and audit

- `PolicyEngine`
- `blockSafetyClasses`
- `requireApprovalFor`
- `maxRunSpendUSD`
- `maxTokenBudget`
- `allowChains`
- `ApprovalManager`
- `AuditEmitter`
- `InMemoryAuditSink`

### Testing

- `ReplayProvider`
- `TraceRecorder`
- `compareTraces`
- `serializeGoldenTrace`
- `deserializeGoldenTrace`

### Transports

- `MCPServerTransport`
- `ACPTransport`
- `A2ATransport`

## Payments, Identity, and Trust Are Optional

`@veridex/agents` works without Veridex protocol primitives, but it becomes much more capable when you wire them in.

```ts
import { createAgent, OpenAIProvider } from '@veridex/agents';
import { createSDK } from '@veridex/sdk';
import { createAgentWallet } from '@veridex/agentic-payments';

const sdk = createSDK('base', {
  network: 'testnet',
  relayerUrl: process.env.RELAYER_URL,
});

const wallet = await createAgentWallet({
  masterCredential: {
    credentialId: process.env.CREDENTIAL_ID!,
    publicKeyX: BigInt(process.env.PUBLIC_KEY_X!),
    publicKeyY: BigInt(process.env.PUBLIC_KEY_Y!),
    keyHash: process.env.KEY_HASH!,
  },
  session: {
    dailyLimitUSD: 100,
    perTransactionLimitUSD: 25,
    expiryHours: 24,
    allowedChains: [10004],
  },
});

const agent = createAgent(
  {
    id: 'treasury-agent',
    name: 'Treasury Agent',
    model: { provider: 'openai', model: 'gpt-4o' },
    instructions: 'Stay inside budget and escalate risky actions.',
    payments: {
      dailyLimitUSD: 100,
      perTransactionLimitUSD: 25,
      allowedChains: ['base'],
      requireApproval: true,
    },
    policies: [
      { type: 'maxRunSpendUSD', params: { limit: 50 } },
      { type: 'requireApprovalFor', params: { safetyClasses: ['payment', 'write'] } },
    ],
  },
  {
    modelProviders: {
      openai: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
    },
    veridexSDK: sdk,
    agentWallet: wallet,
    enableTracing: true,
    enableCheckpoints: true,
  },
);
```

That pattern keeps the runtime general-purpose while allowing agents to become payment-aware, identity-aware, and policy-bound when needed.

## Checkpoints and Approval Resume

The runtime can persist checkpoints and resume suspended runs:

```ts
const result = await agent.run('Move funds if the budget allows it');

if (result.run.state === 'waiting_for_approval') {
  const checkpoints = await agent.listCheckpoints(result.run.id);
  const latest = checkpoints.at(-1);

  if (latest) {
    const resumed = await agent.resumeFromCheckpoint(latest.id, {
      approval: {
        approved: true,
        approver: 'ops-team',
      },
    });

    console.log(resumed.output);
  }
}
```

## Transport Surfaces

The runtime can collaborate with other agent ecosystems through:

- `MCPServerTransport` to expose Veridex tools as MCP-compatible tools
- `ACPTransport` to advertise capabilities and send or receive ACP tasks
- `A2ATransport` to discover and invoke A2A-compatible agents

If you need higher-level migration or live bridges into specific external frameworks, use `@veridex/agents-adapters` or `@veridex/agents-openclaw`.

## Testing and Regression

The package includes testing helpers so runtime behavior can be replayed and compared:

```ts
import { TraceRecorder, compareTraces } from '@veridex/agents';
```

Use them when you want:

- regression protection around tool behavior
- deterministic review of model or tool execution traces
- golden-trace comparisons during refactors

## Related Packages

| Package | Use it for |
|---|---|
| `@veridex/agents-react` | React provider and hooks for runs, approvals, traces, budgets, identity, and reputation |
| `@veridex/agents-adapters` | Import/export adapters and live runtime bridges for OpenAI Agents, LangGraph, PydanticAI, and OpenAPI |
| `@veridex/agents-openclaw` | OpenClaw and Pi skill/context/ACP interoperability |
| `@veridex/agents-control-plane` | Multi-tenant approvals, trace retention, policy packs, audit export, and remote service deployment |
| `@veridex/sdk` | Passkeys, sessions, wallets, and cross-chain primitives |
| `@veridex/agentic-payments` | Payment routing, trust, reputation, and agentic commerce primitives |

## Known Rough Edges

- The package is young, so naming and ergonomics may still tighten.
- Some interop and transport surfaces are broader than their current example coverage.
- Payments and trust flows depend on the lower-layer SDKs being configured correctly.
- You should still test your own tool failure, retry, and approval behavior explicitly before production rollout.

Contributions are welcome, especially around examples, runtime ergonomics, transport hardening, and documentation improvements.
