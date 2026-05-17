import { describe, it, expect, vi } from 'vitest';
import {
  InMemorySandboxLifecycleManager,
  type SandboxFactory,
} from '../src/execution';
import type { SandboxRuntime } from '../src/execution/Sandbox';

function makeSandbox(): SandboxRuntime & { disposed: number } {
  const sb = {
    disposed: 0,
    capabilities: () => ({ languages: ['bash' as const], network: 'deny' as const }),
    execute: async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      truncated: false,
    }),
    dispose: async (): Promise<void> => {
      sb.disposed++;
    },
  };
  return sb as any;
}

function factory(opts?: Partial<SandboxFactory>): SandboxFactory {
  return {
    vendor: 'test',
    create: vi.fn(async () => makeSandbox()),
    ...opts,
  } as SandboxFactory;
}

describe('InMemorySandboxLifecycleManager', () => {
  it('acquire creates once and reuses', async () => {
    const f = factory();
    const m = new InMemorySandboxLifecycleManager({ factory: f });
    const a = await m.acquire('s1');
    const b = await m.acquire('s1');
    expect(a).toBe(b);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('release disposes the sandbox', async () => {
    const f = factory();
    const m = new InMemorySandboxLifecycleManager({ factory: f });
    const s = (await m.acquire('s1')) as any;
    await m.release('s1');
    expect(s.disposed).toBe(1);
    expect(m.size()).toBe(0);
  });

  it('snapshot returns null when unsupported', async () => {
    const m = new InMemorySandboxLifecycleManager({ factory: factory() });
    await m.acquire('s1');
    expect(await m.snapshot('s1')).toBeNull();
  });

  it('snapshot throws when no session', async () => {
    const m = new InMemorySandboxLifecycleManager({ factory: factory() });
    await expect(m.snapshot('missing')).rejects.toThrow(/no sandbox/);
  });

  it('restore rejects vendor mismatch', async () => {
    const m = new InMemorySandboxLifecycleManager({
      factory: factory({
        snapshot: async () => ({ id: 'x', vendor: 'test', createdAt: 0 }),
        restore: async () => makeSandbox(),
      }),
    });
    await expect(
      m.restore('s1', { id: 'x', vendor: 'other', createdAt: 0 }),
    ).rejects.toThrow(/vendor/);
  });

  it('enforces maxConcurrent via LRU eviction', async () => {
    let clock = 0;
    const f = factory();
    const m = new InMemorySandboxLifecycleManager({
      factory: f,
      maxConcurrent: 2,
      now: () => clock,
    });
    clock = 1;
    await m.acquire('a');
    clock = 2;
    await m.acquire('b');
    clock = 3;
    await m.acquire('c'); // should evict 'a' (oldest lastTouched)
    expect(m.size()).toBe(2);
    // re-acquiring 'a' should create a new instance
    expect(f.create).toHaveBeenCalledTimes(3);
  });

  it('releaseAll disposes everything', async () => {
    const m = new InMemorySandboxLifecycleManager({ factory: factory() });
    await m.acquire('a');
    await m.acquire('b');
    await m.releaseAll();
    expect(m.size()).toBe(0);
  });
});
