import { describe, it, expect, beforeEach } from 'vitest';
import { CheckpointManager, InMemoryCheckpointStore } from '../src/checkpoints/CheckpointManager';

describe('CheckpointManager', () => {
  let manager: CheckpointManager;

  beforeEach(() => {
    manager = new CheckpointManager();
  });

  it('saves and loads a checkpoint', async () => {
    const cp = await manager.save('run_1', 'agent_1', 0, { foo: 'bar' }, 'suspend');

    const loaded = await manager.load(cp.id);
    expect(loaded).toBeDefined();
    expect(loaded!.runId).toBe('run_1');
    expect(loaded!.agentId).toBe('agent_1');
    expect(loaded!.turnIndex).toBe(0);
    expect(loaded!.reason).toBe('suspend');
  });

  it('parses checkpoint state', async () => {
    const cp = await manager.save('run_1', 'agent_1', 0, { count: 42 });

    const state = manager.parseState(cp);
    expect(state.count).toBe(42);
  });

  it('loads latest checkpoint for a run', async () => {
    await manager.save('run_1', 'agent_1', 0, { turn: 0 });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    const latest = await manager.save('run_1', 'agent_1', 1, { turn: 1 });

    const loaded = await manager.loadLatest('run_1');
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(latest.id);
  });

  it('lists checkpoints for a run', async () => {
    await manager.save('run_1', 'agent_1', 0, {});
    await manager.save('run_1', 'agent_1', 1, {});
    await manager.save('run_2', 'agent_1', 0, {});

    const list = await manager.list('run_1');
    expect(list).toHaveLength(2);
  });

  it('deletes a checkpoint', async () => {
    const cp = await manager.save('run_1', 'agent_1', 0, {});
    expect(await manager.delete(cp.id)).toBe(true);
    expect(await manager.load(cp.id)).toBeNull();
  });

  it('clears all checkpoints', async () => {
    await manager.save('run_1', 'agent_1', 0, {});
    await manager.save('run_2', 'agent_1', 0, {});
    await manager.clear();

    expect(await manager.list('run_1')).toHaveLength(0);
    expect(await manager.list('run_2')).toHaveLength(0);
  });

  it('clears checkpoints for a specific run', async () => {
    await manager.save('run_1', 'agent_1', 0, {});
    await manager.save('run_2', 'agent_1', 0, {});
    await manager.clear('run_1');

    expect(await manager.list('run_1')).toHaveLength(0);
    expect(await manager.list('run_2')).toHaveLength(1);
  });

  it('returns null for non-existent checkpoint', async () => {
    expect(await manager.load('nonexistent')).toBeNull();
  });

  it('returns null for loadLatest with no checkpoints', async () => {
    expect(await manager.loadLatest('nonexistent')).toBeNull();
  });
});

describe('InMemoryCheckpointStore', () => {
  let store: InMemoryCheckpointStore;

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
  });

  it('implements the CheckpointStore interface', async () => {
    await store.save({
      id: 'ckpt_1',
      runId: 'run_1',
      agentId: 'agent_1',
      turnIndex: 0,
      state: '{}',
      createdAt: Date.now(),
      reason: 'periodic',
    });

    const loaded = await store.load('ckpt_1');
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe('ckpt_1');
  });

  it('returns copies (not references)', async () => {
    await store.save({
      id: 'ckpt_1',
      runId: 'run_1',
      agentId: 'agent_1',
      turnIndex: 0,
      state: '{}',
      createdAt: Date.now(),
      reason: 'periodic',
    });

    const a = await store.load('ckpt_1');
    const b = await store.load('ckpt_1');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
