/**
 * Tests for tool description discipline:
 *   - compileToolDescription deterministically flattens guidance.
 *   - formatToolError applies templates with placeholder substitution.
 *   - lintToolContract flags the documented anti-patterns.
 *   - tool() auto-compiles description from guidance when omitted.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  tool,
  compileToolDescription,
  formatToolError,
  lintToolContract,
  ToolRegistry,
} from '../src';
import type { ToolContract } from '../src';

describe('compileToolDescription', () => {
  it('orders summary, when-to-use, when-not-to-use, success example', () => {
    const out = compileToolDescription({
      summary: 'Fetch a balance.',
      whenToUse: ['Pre-trade balance check.', 'User asks "how much".'],
      whenNotToUse: ['Historical balances.'],
      successExample: '{ "balance": "1.0" }',
    });
    const summaryIdx = out.indexOf('Fetch a balance.');
    const useIdx = out.indexOf('Use when:');
    const notUseIdx = out.indexOf('Do NOT use when:');
    const successIdx = out.indexOf('Successful result:');
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(useIdx).toBeGreaterThan(summaryIdx);
    expect(notUseIdx).toBeGreaterThan(useIdx);
    expect(successIdx).toBeGreaterThan(notUseIdx);
    expect(out).toContain('  - Pre-trade balance check.');
    expect(out).toContain('  - Historical balances.');
  });

  it('falls back to fallback summary when guidance.summary is empty', () => {
    const out = compileToolDescription({ whenToUse: ['x'] }, 'Fallback summary.');
    expect(out.startsWith('Fallback summary.')).toBe(true);
  });
});

describe('formatToolError', () => {
  const contract = {
    name: 'fetch_balance',
    errorTemplates: {
      byCode: {
        rate_limited: 'Retry after {retryAfter}s; was {message}.',
        not_found: 'No wallet at {address}.',
      },
      default: 'fetch_balance failed ({code}): {message}',
    },
  };

  it('substitutes named placeholders including code and message', () => {
    expect(
      formatToolError(contract, 'rate_limited', { retryAfter: 30, message: 'too many calls' }),
    ).toBe('Retry after 30s; was too many calls.');
  });

  it('falls back to default when code is unknown', () => {
    expect(formatToolError(contract, 'weird_code', { message: 'oops' })).toBe(
      'fetch_balance failed (weird_code): oops',
    );
  });

  it('falls back to a synthetic default when no templates configured', () => {
    expect(
      formatToolError({ name: 'no_templates', errorTemplates: undefined }, 'boom', { message: 'x' }),
    ).toBe('no_templates failed (boom): x');
  });

  it('leaves unknown placeholders alone', () => {
    expect(formatToolError(contract, 'rate_limited', { retryAfter: 5 })).toContain('{message}');
  });
});

describe('lintToolContract', () => {
  function base(overrides: Partial<ToolContract> = {}): ToolContract {
    return {
      name: 'fetch_thing',
      description: 'A reasonably long description that explains the tool well enough.',
      input: z.object({}),
      safetyClass: 'read',
      execute: async () => ({ llmOutput: '', success: true }),
      guidance: {
        whenToUse: ['some case'],
        whenNotToUse: ['some anti-case'],
      },
      errorTemplates: { default: 'failed: {message}' },
      ...overrides,
    };
  }

  it('produces no issues for a well-formed contract', () => {
    const issues = lintToolContract(base());
    expect(issues).toHaveLength(0);
  });

  it('flags missing description as error', () => {
    const issues = lintToolContract(base({ description: '' }));
    expect(issues.some((i) => i.code === 'description_missing' && i.severity === 'error')).toBe(true);
  });

  it('flags short description as warn', () => {
    const issues = lintToolContract(base({ description: 'too short' }));
    expect(issues.some((i) => i.code === 'description_short' && i.severity === 'warn')).toBe(true);
  });

  it('flags missing whenToUse as warn', () => {
    const issues = lintToolContract(base({ guidance: { whenNotToUse: ['x'] } }));
    expect(issues.some((i) => i.code === 'guidance_missing_when_to_use')).toBe(true);
  });

  it('flags non-snake_case names as info', () => {
    const issues = lintToolContract(base({ name: 'FetchThing' }));
    expect(issues.some((i) => i.code === 'name_not_verb_phrase')).toBe(true);
  });

  it('flags missing error templates as info', () => {
    const issues = lintToolContract(base({ errorTemplates: undefined }));
    expect(issues.some((i) => i.code === 'no_error_templates')).toBe(true);
  });

  it('flags destructive tool without idempotency declaration', () => {
    const issues = lintToolContract(
      base({ safetyClass: 'destructive', idempotent: undefined }),
    );
    expect(
      issues.some((i) => i.code === 'destructive_without_idempotency_signal' && i.severity === 'warn'),
    ).toBe(true);
  });
});

describe('tool() helper', () => {
  it('auto-compiles description from guidance when omitted', () => {
    const t = tool({
      name: 'fetch_thing',
      guidance: {
        summary: 'Fetch.',
        whenToUse: ['always'],
      },
      input: z.object({}),
      safetyClass: 'read',
      execute: async () => ({ llmOutput: '', success: true }),
    });
    expect(t.description).toContain('Fetch.');
    expect(t.description).toContain('Use when:');
    expect(t.description).toContain('  - always');
  });

  it('preserves explicit description verbatim', () => {
    const t = tool({
      name: 'fetch_thing',
      description: 'EXPLICIT.',
      guidance: { whenToUse: ['x'] },
      input: z.object({}),
      safetyClass: 'read',
      execute: async () => ({ llmOutput: '', success: true }),
    });
    expect(t.description).toBe('EXPLICIT.');
  });

  it('round-trips guidance and errorTemplates onto the contract', () => {
    const t = tool({
      name: 'fetch_thing',
      guidance: { summary: 's', whenToUse: ['w'] },
      errorTemplates: { default: 'd' },
      input: z.object({}),
      safetyClass: 'read',
      execute: async () => ({ llmOutput: '', success: true }),
    });
    expect(t.guidance?.whenToUse).toEqual(['w']);
    expect(t.errorTemplates?.default).toBe('d');
  });
});

describe('ToolRegistry.lint', () => {
  it('reports issues for every registered tool', () => {
    const registry = new ToolRegistry();
    registry.register(
      tool({
        name: 'BadName',
        description: 'short',
        input: z.object({}),
        safetyClass: 'read',
        execute: async () => ({ llmOutput: '', success: true }),
      }),
    );
    const report = registry.lint();
    expect(report).toHaveLength(1);
    expect(report[0].name).toBe('BadName');
    expect(report[0].issues.some((i) => i.code === 'name_not_verb_phrase')).toBe(true);
    expect(report[0].issues.some((i) => i.code === 'description_short')).toBe(true);
  });
});
