/**
 * Tests for the sandbox runtime surface.
 */
import { describe, it, expect } from 'vitest';
import {
  DenyAllSandbox,
  LocalProcessSandbox,
  createSandboxedExecTool,
} from '../src';
import { existsSync } from 'node:fs';

describe('DenyAllSandbox', () => {
  it('refuses every request with the `denied` code', async () => {
    const sandbox = new DenyAllSandbox();
    const r = await sandbox.execute({ code: 'print(1)', language: 'python' });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('denied');
    expect(r.stderr).toContain('No sandbox runtime is configured');
  });

  it('exposes empty capabilities and isolated=true', () => {
    const caps = new DenyAllSandbox().capabilities();
    expect(caps.languages).toEqual([]);
    expect(caps.isolated).toBe(true);
  });
});

const PYTHON = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(
  (p) => existsSync(p),
);

describe.skipIf(!PYTHON)('LocalProcessSandbox (python)', () => {
  it('runs simple python and returns stdout', async () => {
    const sandbox = new LocalProcessSandbox({ allowedBinaries: { python: PYTHON } });
    const r = await sandbox.execute({
      code: 'print("hello")',
      language: 'python',
      timeoutMs: 5_000,
    });
    expect(r.success).toBe(true);
    expect(r.stdout.trim()).toBe('hello');
    expect(r.exitCode).toBe(0);
  });

  it('enforces timeout and returns timeout errorCode', async () => {
    const sandbox = new LocalProcessSandbox({ allowedBinaries: { python: PYTHON } });
    const r = await sandbox.execute({
      code: 'import time\ntime.sleep(5)',
      language: 'python',
      timeoutMs: 200,
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('timeout');
  }, 10_000);

  it('truncates output past maxOutputBytes', async () => {
    const sandbox = new LocalProcessSandbox({ allowedBinaries: { python: PYTHON } });
    const r = await sandbox.execute({
      code: 'print("x" * 1000000)',
      language: 'python',
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    });
    expect(r.errorCode).toBe('output_truncated');
    expect(r.stdout.length).toBeLessThanOrEqual(1024);
  });

  it('refuses non-deny network policy', async () => {
    const sandbox = new LocalProcessSandbox({ allowedBinaries: { python: PYTHON } });
    const r = await sandbox.execute({
      code: 'print(1)',
      language: 'python',
      network: { mode: 'open' },
    });
    expect(r.errorCode).toBe('network_denied');
  });

  it('refuses unsupported languages', async () => {
    const sandbox = new LocalProcessSandbox({ allowedBinaries: { python: PYTHON } });
    const r = await sandbox.execute({ code: 'echo hi', language: 'bash' });
    expect(r.errorCode).toBe('language_unsupported');
  });
});

describe('createSandboxedExecTool', () => {
  it('refuses to build when the runtime advertises no languages', () => {
    expect(() => createSandboxedExecTool({ runtime: new DenyAllSandbox() })).toThrow();
  });

  it.skipIf(!PYTHON)('returns a tool with destructive class and full guidance', () => {
    const sandbox = new LocalProcessSandbox({ allowedBinaries: { python: PYTHON } });
    const t = createSandboxedExecTool({ runtime: sandbox });
    expect(t.safetyClass).toBe('destructive');
    expect(t.idempotent).toBe(false);
    expect(t.guidance?.whenToUse?.length).toBeGreaterThan(0);
    expect(t.guidance?.whenNotToUse?.length).toBeGreaterThan(0);
    expect(t.errorTemplates?.byCode?.timeout).toContain('timeoutMs');
    expect(t.description).toContain('Use when:');
  });

  it.skipIf(!PYTHON)('execute returns stdout on success', async () => {
    const sandbox = new LocalProcessSandbox({ allowedBinaries: { python: PYTHON } });
    const t = createSandboxedExecTool({ runtime: sandbox });
    const result = await t.execute({
      input: { code: 'print(2 + 2)', language: 'python' },
      context: { runId: 'r', agentId: 'a', turnIndex: 0 },
    });
    expect(result.success).toBe(true);
    expect(result.llmOutput).toContain('4');
  });

  it.skipIf(!PYTHON)('execute formats timeout via errorTemplates', async () => {
    const sandbox = new LocalProcessSandbox({ allowedBinaries: { python: PYTHON } });
    const t = createSandboxedExecTool({ runtime: sandbox });
    const result = await t.execute({
      input: {
        code: 'import time; time.sleep(5)',
        language: 'python',
        timeoutMs: 100,
      },
      context: { runId: 'r', agentId: 'a', turnIndex: 0 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('100ms');
  }, 10_000);
});
