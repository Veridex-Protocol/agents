# Contributing to @veridex/agents

## Prerequisites

- Node.js 18+
- [Bun](https://bun.sh/) (used as package manager)
- TypeScript 5.x

## Setup

```bash
# From the monorepo root
bun install

# Navigate to the agents package
cd packages/agents
```

## Build & Test

```bash
# Type-check (no output = clean)
npx tsc --noEmit

# Run all tests
npx vitest run

# Run a specific test file
npx vitest run tests/streaming.test.ts

# Build for distribution
npm run build
```

## Project Layout

```
src/
├── runtime/          AgentRuntime, createAgent, run loop
├── tools/            Tool contracts, executor, built-in tools (Planning, Filesystem, Subagent)
├── memory/           MemoryManager, InMemoryStore
├── context/          ContextCompiler — prompt construction from instructions + memory + state
├── stores/           Postgres-backed persistent stores (Run, Thread, Memory, Transcript, etc.)
├── streaming/        SSE helpers — eventToSSE, streamToSSE, streamTokens
├── policy/           PolicyEngine, built-in policy rules
├── approvals/        ApprovalManager, routing, handlers
├── checkpoints/      CheckpointManager, InMemoryCheckpointStore
├── events/           EventBus, EventLog, TraceRecorder
├── models/           OpenAIProvider, AnthropicProvider, ModelRegistry, ReplayProvider
├── transports/       MCP, ACP, A2A transport surfaces
├── types/            All shared type definitions
└── index.ts          Public barrel exports
tests/
├── *.test.ts         Test files (vitest)
```

## Writing Tests

Tests use [Vitest](https://vitest.dev/). Place test files in `tests/` with a `.test.ts` suffix.

- Use `ReplayProvider` for deterministic model responses instead of calling real APIs.
- Mock external dependencies (Postgres, network) — see `tests/postgres-stores.test.ts` for a mock DB pattern.
- Run `npx tsc --noEmit` before submitting — type errors are blocking.

## Code Conventions

- No `as any`, `@ts-ignore`, or `@ts-expect-error`.
- No empty catch blocks.
- Match existing patterns. If the codebase does X, do X.
- Tools use `tool({ ... })` with explicit `safetyClass` and Zod schemas.
- Store interfaces live in `src/types/`; implementations in `src/memory/`, `src/stores/`, etc.
- Approval handlers are functions `(request: ApprovalRequest) => Promise<ApprovalDecision>`, not classes.

## Adding a Feature

1. Check if the type interface already exists in `src/types/`.
2. Implement against the interface.
3. Export from `src/index.ts`.
4. Write tests.
5. Run `npx tsc --noEmit && npx vitest run` — both must pass.

## Adding a Postgres Store

Follow the pattern in `src/stores/postgres.ts`:

- Implement the store interface.
- Use `MigrationTracker` for auto-create DDL.
- Accept `PostgresQueryExecutor` (compatible with `pg`, `postgres.js`, Drizzle).
- Prefix tables with `safeSqlIdentifier(tablePrefix)`.
- Test with a mock DB — no real Postgres required for unit tests.

## Submitting Changes

- Keep PRs focused — one feature or fix per PR.
- Include tests for new behavior.
- Update the README if you're adding new public exports.
- Don't refactor unrelated code in a bugfix PR.
