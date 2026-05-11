/**
 * Tests for the DeclarativePolicy YAML/JSON → PolicyRule compiler.
 */

import { describe, it, expect } from 'vitest';
import {
  compileDeclarativePolicy,
  DeclarativePolicySchema,
} from '../src/policy/DeclarativePolicy';
import type { ToolContract } from '../src/types/tools';

function mkTools(entries: Array<[string, Partial<ToolContract>]>): Map<string, ToolContract> {
  const m = new Map<string, ToolContract>();
  for (const [name, patch] of entries) {
    m.set(name, {
      name,
      description: patch.description ?? name,
      safetyClass: patch.safetyClass ?? 'read_public',
      inputSchema: patch.inputSchema ?? ({} as any),
      execute: patch.execute ?? (async () => ({ ok: true } as any)),
      ...patch,
    } as ToolContract);
  }
  return m;
}

describe('DeclarativePolicy compiler', () => {
  it('compiles a minimal policy with a single rule', () => {
    const rules = compileDeclarativePolicy({
      version: 1,
      rules: [
        { id: 'cap', verb: 'max-run-spend-usd', limit: 5 },
      ],
    });
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('cap');
    expect(rules[0].description).toContain('$5');
  });

  it('compiles all supported verbs and preserves author ids', () => {
    const tools = mkTools([
      ['payments.send', { safetyClass: 'write_financial' }],
      ['shell.exec', { safetyClass: 'write_system' }],
    ]);
    const rules = compileDeclarativePolicy(
      {
        version: 1,
        rules: [
          { id: 'block-sys', verb: 'block-safety-classes', classes: ['write_system'] },
          {
            id: 'approve-fin',
            verb: 'require-approval-for-safety-classes',
            classes: ['write_financial'],
          },
          { id: 'cap-spend', verb: 'max-run-spend-usd', limit: 10 },
          { id: 'cap-tokens', verb: 'max-token-budget', limit: 100_000 },
          { id: 'only-base', verb: 'allow-chains', chains: ['base', 'ethereum'] },
          { id: 'envelope', verb: 'require-verified-envelope', riskBump: 0.3 },
        ],
      },
      { tools },
    );

    expect(rules.map((r) => r.id)).toEqual([
      'block-sys',
      'approve-fin',
      'cap-spend',
      'cap-tokens',
      'only-base',
      'envelope',
    ]);
  });

  it('rejects duplicate rule ids', () => {
    expect(() =>
      compileDeclarativePolicy({
        version: 1,
        rules: [
          { id: 'dup', verb: 'max-run-spend-usd', limit: 1 },
          { id: 'dup', verb: 'max-token-budget', limit: 100 },
        ],
      }),
    ).toThrow(/duplicate rule id/);
  });

  it('rejects unknown verbs with a Zod error', () => {
    expect(() =>
      compileDeclarativePolicy({
        version: 1,
        rules: [{ id: 'x', verb: 'eval-arbitrary-code', script: 'rm -rf /' } as any],
      }),
    ).toThrow();
  });

  it('rejects missing tool map when a safety-class verb is used', () => {
    expect(() =>
      compileDeclarativePolicy({
        version: 1,
        rules: [{ id: 'b', verb: 'block-safety-classes', classes: ['write_system'] }],
      }),
    ).toThrow(/requires a tool contract map/);
  });

  it('rejects empty rules array', () => {
    expect(() =>
      compileDeclarativePolicy({ version: 1, rules: [] }),
    ).toThrow();
  });

  it('rejects wrong version', () => {
    expect(() =>
      compileDeclarativePolicy({
        version: 2,
        rules: [{ id: 'x', verb: 'max-run-spend-usd', limit: 1 }],
      }),
    ).toThrow();
  });

  it('block rule actually blocks on evaluation', async () => {
    const tools = mkTools([['shell.exec', { safetyClass: 'write_system' }]]);
    const [rule] = compileDeclarativePolicy(
      {
        version: 1,
        rules: [
          { id: 'block-sys', verb: 'block-safety-classes', classes: ['write_system'] },
        ],
      },
      { tools },
    );
    const result = await rule.evaluate({
      runId: 'r', agentId: 'a', turnIndex: 0,
      proposal: {
        type: 'tool_call',
        toolCalls: [{ name: 'shell.exec', arguments: {} }],
      } as any,
    });
    expect(result.verdict).toBe('block');
    expect(result.passed).toBe(false);
  });

  it('max-run-spend-usd blocks when exceeded', async () => {
    const [rule] = compileDeclarativePolicy({
      version: 1,
      rules: [{ id: 'cap', verb: 'max-run-spend-usd', limit: 5 }],
    });
    const result = await rule.evaluate({
      runId: 'r', agentId: 'a', turnIndex: 0,
      proposal: { type: 'tool_call', toolCalls: [] } as any,
      runSpendUSD: 10,
    });
    expect(result.verdict).toBe('block');
  });

  it('allow-chains lets allowed chain through, blocks others', async () => {
    const [rule] = compileDeclarativePolicy({
      version: 1,
      rules: [{ id: 'chains', verb: 'allow-chains', chains: ['base'] }],
    });
    const ok = await rule.evaluate({
      runId: 'r', agentId: 'a', turnIndex: 0,
      proposal: {
        type: 'tool_call',
        toolCalls: [{ name: 't', arguments: { chain: 'base' } }],
      } as any,
    });
    expect(ok.verdict).toBe('pass');
    const blocked = await rule.evaluate({
      runId: 'r', agentId: 'a', turnIndex: 0,
      proposal: {
        type: 'tool_call',
        toolCalls: [{ name: 't', arguments: { chain: 'solana' } }],
      } as any,
    });
    expect(blocked.verdict).toBe('block');
  });

  it('schema itself validates the shape exported publicly', () => {
    const ok = DeclarativePolicySchema.safeParse({
      version: 1,
      rules: [{ id: 'x', verb: 'max-token-budget', limit: 1 }],
    });
    expect(ok.success).toBe(true);
  });
});
