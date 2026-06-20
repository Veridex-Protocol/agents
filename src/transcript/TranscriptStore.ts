/**
 * @packageDocumentation
 * @module TranscriptStore
 * @description
 * Lightweight transcript stores for local replay and checkpoint restore.
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  TranscriptEntry,
  TranscriptRef,
  TranscriptReplayOptions,
  TranscriptStore,
} from '../types/transcript';

function cloneEntry(entry: TranscriptEntry): TranscriptEntry {
  return {
    ...entry,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  };
}

function filterEntries(
  entries: TranscriptEntry[],
  options?: TranscriptReplayOptions,
): TranscriptEntry[] {
  let filtered = [...entries];

  if (options?.kinds?.length) {
    const allowed = new Set(options.kinds);
    filtered = filtered.filter((entry) => allowed.has(entry.kind));
  }

  if (options?.sinceTimestamp !== undefined) {
    filtered = filtered.filter((entry) => entry.timestamp >= options.sinceTimestamp!);
  }

  if (options?.turnIndex !== undefined) {
    filtered = filtered.filter((entry) => entry.turnIndex === options.turnIndex);
  }

  if (options?.limit !== undefined) {
    filtered = filtered.slice(-options.limit);
  }

  return filtered;
}

export class InMemoryTranscriptStore implements TranscriptStore {
  readonly mode = 'memory' as const;

  private transcripts = new Map<string, TranscriptEntry[]>();

  async append(entry: TranscriptEntry): Promise<void> {
    const existing = this.transcripts.get(entry.runId) ?? [];
    existing.push(cloneEntry(entry));
    this.transcripts.set(entry.runId, existing);
  }

  async appendMany(entries: TranscriptEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.append(entry);
    }
  }

  async list(runId: string): Promise<TranscriptEntry[]> {
    return (this.transcripts.get(runId) ?? []).map(cloneEntry);
  }

  async replay(
    runId: string,
    options?: TranscriptReplayOptions,
  ): Promise<TranscriptEntry[]> {
    return filterEntries(await this.list(runId), options);
  }

  async compact(runId: string, keepLast = 50): Promise<void> {
    const entries = this.transcripts.get(runId);
    if (!entries || entries.length <= keepLast) return;
    this.transcripts.set(runId, entries.slice(-keepLast).map(cloneEntry));
  }

  async replace(runId: string, entries: TranscriptEntry[]): Promise<void> {
    this.transcripts.set(runId, entries.map(cloneEntry));
  }

  async clear(runId?: string): Promise<void> {
    if (!runId) {
      this.transcripts.clear();
      return;
    }
    this.transcripts.delete(runId);
  }

  async getRef(runId: string): Promise<TranscriptRef> {
    const entries = this.transcripts.get(runId) ?? [];
    return {
      runId,
      mode: this.mode,
      entryCount: entries.length,
      lastUpdatedAt: entries.at(-1)?.timestamp,
    };
  }
}

export class FileTranscriptStore implements TranscriptStore {
  readonly mode = 'file' as const;

  constructor(private readonly directory = '.veridex/transcripts') {}

  async append(entry: TranscriptEntry): Promise<void> {
    const entries = await this.list(entry.runId);
    entries.push(cloneEntry(entry));
    await this.replace(entry.runId, entries);
  }

  async appendMany(entries: TranscriptEntry[]): Promise<void> {
    const grouped = new Map<string, TranscriptEntry[]>();
    for (const entry of entries) {
      const existing = grouped.get(entry.runId) ?? [];
      existing.push(cloneEntry(entry));
      grouped.set(entry.runId, existing);
    }

    for (const [runId, groupedEntries] of grouped.entries()) {
      const existing = await this.list(runId);
      await this.replace(runId, [...existing, ...groupedEntries]);
    }
  }

  async list(runId: string): Promise<TranscriptEntry[]> {
    try {
      const raw = await readFile(this.filePath(runId), 'utf8');
      const parsed = JSON.parse(raw) as TranscriptEntry[];
      return parsed.map(cloneEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async replay(
    runId: string,
    options?: TranscriptReplayOptions,
  ): Promise<TranscriptEntry[]> {
    return filterEntries(await this.list(runId), options);
  }

  async compact(runId: string, keepLast = 50): Promise<void> {
    const entries = await this.list(runId);
    if (entries.length <= keepLast) return;
    await this.replace(runId, entries.slice(-keepLast));
  }

  async replace(runId: string, entries: TranscriptEntry[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      this.filePath(runId),
      JSON.stringify(entries.map(cloneEntry), null, 2),
      'utf8',
    );
  }

  async clear(runId?: string): Promise<void> {
    if (runId) {
      try {
        await unlink(this.filePath(runId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      return;
    }

    try {
      const files = await readdir(this.directory);
      await Promise.all(files
        .filter((name) => name.endsWith('.json'))
        .map((name) => unlink(join(this.directory, name))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  async getRef(runId: string): Promise<TranscriptRef> {
    const entries = await this.list(runId);
    return {
      runId,
      mode: this.mode,
      entryCount: entries.length,
      path: this.filePath(runId),
      lastUpdatedAt: entries.at(-1)?.timestamp,
    };
  }

  private filePath(runId: string): string {
    return join(this.directory, `${runId}.json`);
  }
}
