import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookRegistry } from '../src/hooks/HookRegistry';
import { HookRunner } from '../src/hooks/HookRunner';
import type { RuntimeHook, HookResult } from '../src/types/hooks';

function makeHook(overrides?: Partial<RuntimeHook>): RuntimeHook {
  return {
    name: 'test_hook',
    phase: 'beforeRun',
    execute: vi.fn(async () => undefined),
    ...overrides,
  };
}

// ── HookRegistry ──

describe('HookRegistry', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('registers and retrieves hooks by phase', () => {
    const hook = makeHook({ phase: 'beforeRun' });
    registry.register(hook);

    expect(registry.getForPhase('beforeRun')).toEqual([hook]);
  });

  it('sorts hooks by priority', () => {
    registry.register(makeHook({ name: 'low', phase: 'beforeRun', priority: 200 }));
    registry.register(makeHook({ name: 'high', phase: 'beforeRun', priority: 10 }));
    registry.register(makeHook({ name: 'default', phase: 'beforeRun' }));

    const hooks = registry.getForPhase('beforeRun');
    expect(hooks.map((h) => h.name)).toEqual(['high', 'default', 'low']);
  });

  it('returns empty array for unknown phase', () => {
    expect(registry.getForPhase('afterRun')).toEqual([]);
  });

  it('removes hook by name', () => {
    registry.register(makeHook({ name: 'to_remove', phase: 'beforeRun' }));
    expect(registry.remove('to_remove')).toBe(true);
    expect(registry.getForPhase('beforeRun')).toEqual([]);
  });

  it('returns false when removing non-existent hook', () => {
    expect(registry.remove('nope')).toBe(false);
  });

  it('lists all hook names', () => {
    registry.register(makeHook({ name: 'a', phase: 'beforeRun' }));
    registry.register(makeHook({ name: 'b', phase: 'afterRun' }));

    expect(registry.list().sort()).toEqual(['a', 'b']);
  });

  it('clear removes all hooks', () => {
    registry.register(makeHook({ name: 'a', phase: 'beforeRun' }));
    registry.clear();

    expect(registry.list()).toEqual([]);
  });
});

// ── HookRunner ──

describe('HookRunner', () => {
  let registry: HookRegistry;
  let runner: HookRunner;

  beforeEach(() => {
    registry = new HookRegistry();
    runner = new HookRunner(registry);
  });

  it('runs hooks and returns combined result', async () => {
    registry.register(makeHook({
      name: 'h1',
      phase: 'beforeRun',
      execute: async () => ({
        annotations: { key1: 'val1' },
      }),
    }));
    registry.register(makeHook({
      name: 'h2',
      phase: 'beforeRun',
      execute: async () => ({
        annotations: { key2: 'val2' },
      }),
    }));

    const result = await runner.run('beforeRun', {});

    expect(result.override).toBe('continue');
    expect(result.annotations).toEqual({ key1: 'val1', key2: 'val2' });
  });

  it('returns most restrictive override', async () => {
    registry.register(makeHook({
      name: 'continuer',
      phase: 'beforeRun',
      priority: 1,
      execute: async () => ({
        override: 'continue' as const,
      }),
    }));
    registry.register(makeHook({
      name: 'pauser',
      phase: 'beforeRun',
      priority: 2,
      execute: async () => ({
        override: 'pause' as const,
        reason: 'need review',
      }),
    }));

    const result = await runner.run('beforeRun', {});

    expect(result.override).toBe('pause');
    expect(result.reasons).toContain('[pauser] need review');
  });

  it('short-circuits on deny', async () => {
    const afterDeny = vi.fn(async () => undefined);

    registry.register(makeHook({
      name: 'denier',
      phase: 'beforeRun',
      priority: 1,
      execute: async () => ({
        override: 'deny' as const,
        reason: 'blocked',
      }),
    }));
    registry.register(makeHook({
      name: 'should_not_run',
      phase: 'beforeRun',
      priority: 2,
      execute: afterDeny,
    }));

    const result = await runner.run('beforeRun', {});

    expect(result.override).toBe('deny');
    expect(afterDeny).not.toHaveBeenCalled();
  });

  it('isolates hook errors', async () => {
    registry.register(makeHook({
      name: 'bad_hook',
      phase: 'beforeRun',
      execute: async () => {
        throw new Error('hook error');
      },
    }));

    const result = await runner.run('beforeRun', {});

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].hookName).toBe('bad_hook');
    expect(result.override).toBe('continue');
  });

  it('times out slow hooks', async () => {
    registry.register(makeHook({
      name: 'slow_hook',
      phase: 'beforeRun',
      timeoutMs: 50,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { annotations: { slow: true } };
      },
    }));

    const result = await runner.run('beforeRun', {});

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error.message).toContain('timed out');
  });

  it('returns default result when no hooks registered', async () => {
    const result = await runner.run('beforeRun', {});

    expect(result.override).toBe('continue');
    expect(result.annotations).toEqual({});
    expect(result.reasons).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
