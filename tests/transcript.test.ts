import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileTranscriptStore, InMemoryTranscriptStore } from '../src/transcript';
import type { TranscriptEntry } from '../src/types/transcript';

function makeEntry(
  kind: TranscriptEntry['kind'],
  overrides: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id: overrides.id ?? `trn_${kind}`,
    runId: overrides.runId ?? 'run_1',
    agentId: overrides.agentId ?? 'agent_1',
    kind,
    timestamp: overrides.timestamp ?? Date.now(),
    turnIndex: overrides.turnIndex,
    content: overrides.content ?? kind,
    metadata: overrides.metadata,
  };
}

describe('InMemoryTranscriptStore', () => {
  it('appends, replays, compacts, and replaces entries', async () => {
    const store = new InMemoryTranscriptStore();

    await store.appendMany([
      makeEntry('user_input', { id: 'u1', timestamp: 1 }),
      makeEntry('model_output', { id: 'm1', timestamp: 2, turnIndex: 0 }),
      makeEntry('tool_result', { id: 't1', timestamp: 3, turnIndex: 0 }),
    ]);

    expect(await store.list('run_1')).toHaveLength(3);
    expect(await store.replay('run_1', { kinds: ['model_output'] })).toHaveLength(1);
    expect(await store.replay('run_1', { turnIndex: 0 })).toHaveLength(2);

    await store.compact('run_1', 2);
    expect((await store.list('run_1')).map((entry) => entry.id)).toEqual(['m1', 't1']);

    await store.replace('run_1', [makeEntry('system_note', { id: 's1', timestamp: 4 })]);
    expect((await store.list('run_1')).map((entry) => entry.id)).toEqual(['s1']);

    const ref = await store.getRef('run_1');
    expect(ref).toMatchObject({
      runId: 'run_1',
      mode: 'memory',
      entryCount: 1,
      lastUpdatedAt: 4,
    });
  });
});

describe('FileTranscriptStore', () => {
  it('persists transcript state to disk and resolves a file ref', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'veridex-transcripts-'));

    try {
      const store = new FileTranscriptStore(directory);
      await store.appendMany([
        makeEntry('user_input', { id: 'u1', timestamp: 10 }),
        makeEntry('model_output', { id: 'm1', timestamp: 20, turnIndex: 0 }),
      ]);

      const replay = await store.replay('run_1', { sinceTimestamp: 15 });
      expect(replay.map((entry) => entry.id)).toEqual(['m1']);

      const ref = await store.getRef('run_1');
      expect(ref.mode).toBe('file');
      expect(ref.entryCount).toBe(2);
      expect(ref.path).toContain(directory);

      await store.clear('run_1');
      expect(await store.list('run_1')).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
