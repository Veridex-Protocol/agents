# Getting Started with @veridex/agents

This guide walks you through creating your first agent, adding tools, persistent storage, streaming, and approval workflows.

## Install

```bash
npm install @veridex/agents zod
npm install openai  # or @anthropic-ai/sdk
```

## 1. Minimal Agent

```ts
import { createAgent, OpenAIProvider } from '@veridex/agents';

const agent = createAgent(
  {
    id: 'hello-agent',
    name: 'Hello Agent',
    model: { provider: 'openai', model: 'gpt-4o-mini' },
    instructions: 'You are a helpful assistant.',
  },
  {
    modelProviders: {
      openai: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
    },
  },
);

const result = await agent.run('What is 2 + 2?');
console.log(result.output); // "4"
```

## 2. Adding Tools

```ts
import { createAgent, tool, OpenAIProvider } from '@veridex/agents';
import { z } from 'zod';

const getWeather = tool({
  name: 'get_weather',
  description: 'Get current weather for a city',
  input: z.object({ city: z.string() }),
  safetyClass: 'read',
  async execute({ input }) {
    return { success: true, llmOutput: `It's 72°F and sunny in ${input.city}.` };
  },
});

const agent = createAgent(
  {
    id: 'weather-agent',
    name: 'Weather Agent',
    model: { provider: 'openai', model: 'gpt-4o-mini' },
    instructions: 'Help users check the weather.',
    tools: [getWeather],
  },
  {
    modelProviders: { openai: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }) },
  },
);

const result = await agent.run('What is the weather in Tokyo?');
console.log(result.output);
```

### Safety Classes

Every tool declares a `safetyClass`:

| Class | Meaning | Policy default |
|---|---|---|
| `read` | Read-only, no side effects | Auto-allow |
| `write` | Mutates state | May require approval |
| `payment` | Moves money | Requires approval |
| `admin` | Sensitive system operations | Requires approval |

## 3. Built-in Tools

The runtime ships with pre-built tool sets:

```ts
import { PlanningTools, FilesystemTools, SubagentTools } from '@veridex/agents';

const agent = createAgent(
  {
    id: 'dev-agent',
    name: 'Dev Agent',
    model: { provider: 'openai', model: 'gpt-4o' },
    instructions: 'Help with coding tasks. Use tools to read files and plan work.',
    tools: [
      ...PlanningTools(),                                       // write_todo, list_todos
      ...FilesystemTools({ rootDir: '/workspace' }),            // file_read, file_write, file_edit, file_search, file_glob
      ...SubagentTools({ spawnRun: async (def, input) => ({ output: '...' }) }), // delegate_task
    ],
  },
  { modelProviders: { openai: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }) } },
);
```

## 4. Persistent Storage (Postgres)

By default, all state is in-memory. For production, use Postgres stores:

```ts
import { createAgent, createPostgresStores, OpenAIProvider } from '@veridex/agents';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const stores = createPostgresStores({
  executor: { query: (sql, params) => pool.query(sql, params) },
});

const agent = createAgent(
  {
    id: 'prod-agent',
    name: 'Production Agent',
    model: { provider: 'openai', model: 'gpt-4o-mini' },
    instructions: 'You are a production assistant.',
  },
  {
    modelProviders: { openai: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }) },
    ...stores, // runStore, threadStore, executionGraphStore, memoryStore, transcriptStore, checkpointStore
  },
);
```

Tables are auto-created on first use. Works with `pg`, `postgres.js`, and Drizzle.

## 5. Streaming

### Token-level Streaming

```ts
for await (const event of agent.streamRun('Write me a haiku')) {
  if (event.type === 'token_streamed') {
    process.stdout.write(event.data.token);
  }
}
```

### SSE for HTTP Endpoints

```ts
import { streamToSSE, streamTokens } from '@veridex/agents';

// Full event stream as SSE
const sseStream = streamToSSE(agent.streamRun('Hello'));

// Just the token strings
for await (const token of streamTokens(agent.streamRun('Hello'))) {
  process.stdout.write(token);
}
```

## 6. Policies and Approvals

### Declarative Policies

```ts
const agent = createAgent(
  {
    id: 'safe-agent',
    name: 'Safe Agent',
    model: { provider: 'openai', model: 'gpt-4o' },
    instructions: 'Be careful with risky operations.',
    policies: [
      { type: 'requireApprovalFor', params: { safetyClasses: ['write', 'payment'] } },
      { type: 'maxRunSpendUSD', params: { limit: 10 } },
    ],
  },
  {
    modelProviders: { openai: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }) },
    approvalRoutes: [
      { match: (_p, policy) => policy.riskScore >= 80, mode: 'human_required' },
    ],
    approvalHandlers: {
      human_required: async (request) => ({
        requestId: request.id,
        approved: true,
        decidedBy: 'auto-test',
        decidedAt: Date.now(),
      }),
    },
  },
);
```

### Resuming from Approval

When no handler is registered, runs suspend in `waiting_for_approval`:

```ts
const result = await agent.run('Delete the old records');

if (result.run.state === 'waiting_for_approval') {
  const checkpoints = await agent.listCheckpoints(result.run.id);
  const latest = checkpoints.at(-1);

  const resumed = await agent.resumeFromCheckpoint(latest!.id, {
    approval: { approved: true, approver: 'admin@company.com' },
  });

  console.log(resumed.output);
}
```

## 7. Tracing and Events

Enable tracing to get full event streams:

```ts
const agent = createAgent(
  { ... },
  { ..., enableTracing: true },
);

const result = await agent.run('Do something');

// Access all trace events
for (const event of result.events ?? []) {
  console.log(`[${event.type}]`, event.data);
}
```

Event types include: `run_started`, `run_completed`, `turn_started`, `turn_completed`, `tool_started`, `tool_completed`, `token_streamed`, `approval_requested`, and more.

## Next Steps

- Read the [README](./README.md) for a full API tour.
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup.
- Explore `tests/` for working examples of every feature.
