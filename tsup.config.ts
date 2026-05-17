import { defineConfig } from 'tsup';

export default defineConfig({
    entry: [
        'src/index.ts',
        // Namespaced subpath entries — Phase 1.3 architectural realignment.
        // Consumers should prefer `@veridex/agents/runtime` over the flat
        // root export for new code; the root remains for back-compat.
        'src/runtime/index.ts',
        'src/tools/index.ts',
        'src/memory/index.ts',
        'src/context/index.ts',
        'src/policy/index.ts',
        'src/hooks/index.ts',
        'src/approvals/index.ts',
        'src/audit/index.ts',
        'src/checkpoints/index.ts',
        'src/events/index.ts',
        'src/models/index.ts',
        'src/security/index.ts',
        'src/integrations/index.ts',
        'src/evals/index.ts',
        'src/testing/index.ts',
        'src/transports/index.ts',
        'src/stores/index.ts',
        'src/credentials/index.ts',
        'src/intent/index.ts',
        'src/recovery/index.ts',
        'src/skills/index.ts',
        'src/routing/index.ts',
        'src/deploy/index.ts',
    ],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
});
