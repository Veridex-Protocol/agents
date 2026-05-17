import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  NoopLLMResponseGuard,
  NoopSupplyChainGuard,
  generateCanaryToken,
  paymentsGuardsPlugin,
  securityGatewayPlugin,
  type RuntimePlugin,
  type RuntimePluginContext,
} from '../src/index';

/**
 * Phase 1.1 regression guard: core runtime must not import `@veridex/agentic-payments`.
 *
 * Doc comments mentioning the package name are fine; only `import`/`require`
 * statements are forbidden inside `src/runtime/`.
 */
function* walk(dir: string): IterableIterator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts')) yield full;
  }
}

describe('Phase 1.1 — runtime decoupling from @veridex/agentic-payments', () => {
  it('src/runtime/ contains zero static imports of @veridex/agentic-payments', () => {
    const runtimeDir = join(__dirname, '..', 'src', 'runtime');
    const offenders: string[] = [];
    for (const file of walk(runtimeDir)) {
      const src = readFileSync(file, 'utf8');
      // Match `import ... from '@veridex/agentic-payments'` or
      // `require('@veridex/agentic-payments')` — ignore comments by checking
      // the surrounding token shape.
      const importRe = /^\s*import[^'"]*['"]@veridex\/agentic-payments['"]/m;
      const requireRe = /require\(\s*['"]@veridex\/agentic-payments['"]\s*\)/;
      if (importRe.test(src) || requireRe.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exports no-op guard implementations and canary helper', () => {
    expect(new NoopLLMResponseGuard().validate('hi', [])).toEqual({
      safe: true,
      violations: [],
    });
    expect(new NoopSupplyChainGuard().verifyEnvironment()).toEqual({
      safe: true,
      issues: [],
    });
    const token = generateCanaryToken();
    expect(token).toMatch(/^VRDX-CANARY-[0-9A-F]{16}$/);
  });

  it('runtime plugin contract exposes guard setters', () => {
    let installed = false;
    const plugin: RuntimePlugin = {
      id: 'test.plugin',
      install(ctx: RuntimePluginContext) {
        installed = true;
        expect(typeof ctx.setLLMResponseGuard).toBe('function');
        expect(typeof ctx.setSupplyChainGuard).toBe('function');
        expect(ctx.agentId).toBe('test-agent');
        expect(ctx.canaryToken).toMatch(/^VRDX-CANARY-/);
      },
    };
    plugin.install({
      agentId: 'test-agent',
      canaryToken: generateCanaryToken(),
      setLLMResponseGuard: () => {},
      setSupplyChainGuard: () => {},
    });
    expect(installed).toBe(true);
  });

  it('paymentsGuardsPlugin returns a runtime plugin with stable id', () => {
    const plugin = paymentsGuardsPlugin();
    expect(plugin.id).toBe('veridex.payments-guards');
    expect(typeof plugin.install).toBe('function');
  });

  it('securityGatewayPlugin registers a bridging policy via injected gateway', async () => {
    const fakeGateway = {
      async evaluate(): Promise<{
        verdict: 'pass' | 'flag' | 'escalate' | 'block';
        riskScore: number;
        reasons: string[];
      }> {
        return { verdict: 'block', riskScore: 0.9, reasons: ['injection detected'] };
      },
    };
    let registeredRule: { evaluate: (ctx: unknown) => Promise<unknown> } | undefined;
    const plugin = securityGatewayPlugin({ gateway: fakeGateway });
    expect(plugin.id).toBe('veridex.security-gateway');
    plugin.install({
      agentId: 'a',
      canaryToken: generateCanaryToken(),
      setLLMResponseGuard: () => {},
      setSupplyChainGuard: () => {},
      registerTool: () => {},
      registerHook: () => {},
      registerPolicy: (rule) => {
        registeredRule = rule as never;
      },
    });
    expect(registeredRule).toBeDefined();
    const result = (await registeredRule!.evaluate({
      runId: 'r',
      agentId: 'a',
      turnIndex: 0,
      proposal: {
        type: 'tool_call',
        toolCalls: [{ name: 'bash', arguments: { cmd: 'ls' } }],
      },
    })) as { verdict: string; passed: boolean; reason: string };
    expect(result.verdict).toBe('block');
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('injection detected');
  });

  it('plugin context exposes tool/hook/policy registration surface', () => {
    let toolCalled = false;
    let hookCalled = false;
    let policyCalled = false;
    const plugin: RuntimePlugin = {
      id: 'test.broad-surface',
      install(ctx: RuntimePluginContext) {
        expect(typeof ctx.registerTool).toBe('function');
        expect(typeof ctx.registerHook).toBe('function');
        expect(typeof ctx.registerPolicy).toBe('function');
        ctx.registerTool = ((_t: unknown) => {
          toolCalled = true;
        }) as RuntimePluginContext['registerTool'];
        ctx.registerHook = ((_h: unknown) => {
          hookCalled = true;
        }) as RuntimePluginContext['registerHook'];
        ctx.registerPolicy = ((_p: unknown) => {
          policyCalled = true;
        }) as RuntimePluginContext['registerPolicy'];
        ctx.registerTool({} as never);
        ctx.registerHook({} as never);
        ctx.registerPolicy({} as never);
      },
    };
    plugin.install({
      agentId: 'a',
      canaryToken: generateCanaryToken(),
      setLLMResponseGuard: () => {},
      setSupplyChainGuard: () => {},
      registerTool: () => {},
      registerHook: () => {},
      registerPolicy: () => {},
    });
    expect(toolCalled).toBe(true);
    expect(hookCalled).toBe(true);
    expect(policyCalled).toBe(true);
  });
});
