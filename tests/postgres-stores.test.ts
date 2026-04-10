/**
 * Tests for Postgres-backed stores.
 * Uses a mock PostgresQueryExecutor — no real Postgres needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PostgresQueryExecutor, PostgresStoreConfig } from '../src/stores/postgres';
import {
  createPostgresStores,
  PostgresRunStore,
  PostgresThreadStore,
  PostgresExecutionGraphStore,
  PostgresMemoryStore,
  PostgresTranscriptStore,
  PostgresCheckpointStore,
} from '../src/stores/postgres';

// ── Mock DB ──

/** Simple in-memory mock that simulates the PostgresQueryExecutor interface. */
function createMockDb(): PostgresQueryExecutor & { _tables: Map<string, unknown[]> } {
  const tables = new Map<string, unknown[]>();

  function getTableFromSql(sql: string): string {
    // Extract table name from CREATE TABLE, INSERT INTO, SELECT FROM, DELETE FROM, UPDATE
    const match = sql.match(
      /(?:CREATE TABLE IF NOT EXISTS|INSERT INTO|FROM|UPDATE|DELETE FROM)\s+(\w+)/i,
    );
    return match?.[1] ?? 'unknown';
  }

  const db: PostgresQueryExecutor & { _tables: Map<string, unknown[]> } = {
    _tables: tables,
    async query(sql: string, params: unknown[]) {
      // CREATE TABLE — noop
      if (sql.trim().startsWith('CREATE TABLE')) {
        const tableName = getTableFromSql(sql);
        if (!tables.has(tableName)) tables.set(tableName, []);
        return { rows: [], rowCount: 0 };
      }

      const tableName = getTableFromSql(sql);
      if (!tables.has(tableName)) tables.set(tableName, []);
      const rows = tables.get(tableName)!;

      // INSERT ... ON CONFLICT
      if (sql.includes('INSERT INTO')) {
        const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
        if (!colMatch) return { rows: [], rowCount: 0 };

        const cols = colMatch[1].split(',').map((c) => c.trim());
        const record: Record<string, unknown> = {};
        for (let i = 0; i < cols.length; i++) {
          let val = params[i];
          // Handle ::jsonb cast — parse if it's a string that starts with {"
          if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
            try { val = JSON.parse(val); } catch { /* keep as string */ }
          }
          record[cols[i]] = val;
        }

        // ON CONFLICT — upsert
        const pkCol = cols[0];
        const existingIdx = rows.findIndex(
          (r) => (r as Record<string, unknown>)[pkCol] === record[pkCol],
        );

        if (existingIdx >= 0) {
          if (sql.includes('DO NOTHING')) {
            return { rows: [], rowCount: 0 };
          }
          rows[existingIdx] = record;
        } else {
          rows.push(record);
        }

        return { rows: [record], rowCount: 1 };
      }

      // SELECT ... COUNT
      if (sql.includes('COUNT(*)')) {
        const filtered = applyWhereClause(rows, sql, params);
        return { rows: [{ cnt: filtered.length }], rowCount: 1 };
      }

      // SELECT ... MAX
      if (sql.includes('MAX(')) {
        const filtered = applyWhereClause(rows, sql, params);
        let lastTs: number | undefined;
        for (const r of filtered) {
          const ts = Number((r as Record<string, unknown>).timestamp ?? 0);
          if (lastTs === undefined || ts > lastTs) lastTs = ts;
        }
        return {
          rows: [{ cnt: filtered.length, last_ts: lastTs }],
          rowCount: 1,
        };
      }

      // SELECT
      if (sql.trim().startsWith('SELECT')) {
        const filtered = applyWhereClause(rows, sql, params);
        const ordered = applyOrderBy(filtered, sql);
        const limited = applyLimit(ordered, sql, params);

        // Extract projected columns
        const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);
        if (selectMatch) {
          const selectCols = selectMatch[1]
            .split(',')
            .map((c) => c.trim().split(/\s+as\s+/i).pop()?.trim());

          return {
            rows: limited.map((r) => {
              const out: Record<string, unknown> = {};
              for (const col of selectCols ?? []) {
                if (col) out[col] = (r as Record<string, unknown>)[col];
              }
              return out;
            }),
            rowCount: limited.length,
          };
        }

        return { rows: limited as Record<string, unknown>[], rowCount: limited.length };
      }

      // DELETE
      if (sql.trim().startsWith('DELETE')) {
        // SubQuery delete (DELETE ... WHERE id NOT IN (SELECT ...))
        if (sql.includes('NOT IN')) {
          const filtered = applyWhereClause(rows, sql, params);
          // Keep entries that match the subquery
          const subFiltered = rows.filter(
            (r) => !filtered.includes(r),
          );
          const removed = rows.length - subFiltered.length;
          tables.set(tableName, subFiltered);
          return { rows: [], rowCount: removed };
        }

        // SubQuery delete (DELETE ... WHERE id IN (SELECT ...))
        if (sql.includes('WHERE id IN')) {
          // Simple: just apply outer WHERE clause
          const filtered = applyWhereClause(rows, sql, params);
          const remaining = rows.filter((r) => !filtered.includes(r));
          const removed = rows.length - remaining.length;
          tables.set(tableName, remaining);
          return { rows: [], rowCount: removed };
        }

        if (!sql.includes('WHERE')) {
          const count = rows.length;
          tables.set(tableName, []);
          return { rows: [], rowCount: count };
        }

        const toRemove = applyWhereClause(rows, sql, params);
        const remaining = rows.filter((r) => !toRemove.includes(r));
        const removed = rows.length - remaining.length;
        tables.set(tableName, remaining);
        return { rows: [], rowCount: removed };
      }

      // UPDATE
      if (sql.trim().startsWith('UPDATE')) {
        const targets = applyWhereClause(rows, sql, params);
        const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
        if (setMatch) {
          const assignments = setMatch[1].split(',').map((a) => a.trim());
          for (const target of targets) {
            const rec = target as Record<string, unknown>;
            for (const assignment of assignments) {
              const [col, paramRef] = assignment.split('=').map((s) => s.trim());
              const match = paramRef?.match(/\$(\d+)/);
              if (match && col) {
                rec[col] = params[Number(match[1]) - 1];
              }
            }
          }
        }
        return { rows: [], rowCount: targets.length };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  return db;
}

function applyWhereClause(
  rows: unknown[],
  sql: string,
  params: unknown[],
): unknown[] {
  const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|\s*$)/is);
  if (!whereMatch) return [...rows];

  const clause = whereMatch[1];

  // Simple single-condition matching
  const conditions = clause.split(/\s+AND\s+/i);

  return rows.filter((r) => {
    const rec = r as Record<string, unknown>;
    return conditions.every((cond) => {
      const trimmed = cond.trim();

      // Handle ANY($N)
      const anyMatch = trimmed.match(/(\w+)\s*=\s*ANY\(\$(\d+)\)/i);
      if (anyMatch) {
        const col = anyMatch[1];
        const arr = params[Number(anyMatch[2]) - 1] as unknown[];
        return arr.includes(rec[col]);
      }

      // Handle array overlap ($N&&)
      const overlapMatch = trimmed.match(/(\w+)\s*&&\s*\$(\d+)/i);
      if (overlapMatch) {
        const col = overlapMatch[1];
        const arr = params[Number(overlapMatch[2]) - 1] as string[];
        const recArr = rec[col] as string[] | undefined;
        return recArr?.some((t) => arr.includes(t)) ?? false;
      }

      // Handle ILIKE
      const ilikeMatch = trimmed.match(/(\w+)\s+ILIKE\s+\$(\d+)/i);
      if (ilikeMatch) {
        const col = ilikeMatch[1];
        const pattern = String(params[Number(ilikeMatch[2]) - 1]).replace(/%/g, '');
        return String(rec[col] ?? '').toLowerCase().includes(pattern.toLowerCase());
      }

      // Handle JSONB access (data->'x'->>'y')
      const jsonbMatch = trimmed.match(/data->'(\w+)'->>'\s*(\w+)'\s*=\s*\$(\d+)/i);
      if (jsonbMatch) {
        const data = rec.data as Record<string, Record<string, unknown>> | undefined;
        const val = data?.[jsonbMatch[1]]?.[jsonbMatch[2]];
        return val === params[Number(jsonbMatch[3]) - 1];
      }

      // Handle parenthesized TTL expression
      if (trimmed.includes('ttl_ms') && trimmed.includes('created_at + ttl_ms')) {
        const paramMatch = trimmed.match(/\$(\d+)/);
        if (paramMatch) {
          const now = Number(params[Number(paramMatch[1]) - 1]);
          const ttl = Number(rec.ttl_ms ?? 0);
          const created = Number(rec.created_at ?? 0);
          if (ttl === 0) return true; // No expiry
          return (created + ttl) > now;
        }
        return true;
      }

      // Handle simple column = $N
      const eqMatch = trimmed.match(/(\w+)\s*=\s*\$(\d+)/);
      if (eqMatch) {
        return rec[eqMatch[1]] === params[Number(eqMatch[2]) - 1];
      }

      // Handle column >= $N
      const gteMatch = trimmed.match(/(\w+)\s*>=\s*\$(\d+)/);
      if (gteMatch) {
        return Number(rec[gteMatch[1]]) >= Number(params[Number(gteMatch[2]) - 1]);
      }

      // Handle column < $N
      const ltMatch = trimmed.match(/(\w+)\s*<\s*\$(\d+)/);
      if (ltMatch) {
        return Number(rec[ltMatch[1]]) < Number(params[Number(ltMatch[2]) - 1]);
      }

      return true; // Can't parse — include
    });
  });
}

function applyOrderBy(rows: unknown[], sql: string): unknown[] {
  const orderMatch = sql.match(/ORDER BY\s+(\w+)\s+(ASC|DESC)/i);
  if (!orderMatch) return rows;

  const col = orderMatch[1];
  const dir = orderMatch[2].toUpperCase();
  return [...rows].sort((a, b) => {
    const va = Number((a as Record<string, unknown>)[col] ?? 0);
    const vb = Number((b as Record<string, unknown>)[col] ?? 0);
    return dir === 'DESC' ? vb - va : va - vb;
  });
}

function applyLimit(rows: unknown[], sql: string, params: unknown[]): unknown[] {
  const limitMatch = sql.match(/LIMIT\s+\$(\d+)/i);
  if (!limitMatch) return rows;
  const limit = Number(params[Number(limitMatch[1]) - 1]);
  return rows.slice(0, limit);
}

// ── Tests ──

describe('createPostgresStores factory', () => {
  it('creates all 6 stores', () => {
    const db = createMockDb();
    const stores = createPostgresStores({ db });

    expect(stores.runs).toBeInstanceOf(PostgresRunStore);
    expect(stores.threads).toBeInstanceOf(PostgresThreadStore);
    expect(stores.executionGraphs).toBeInstanceOf(PostgresExecutionGraphStore);
    expect(stores.memory).toBeInstanceOf(PostgresMemoryStore);
    expect(stores.transcripts).toBeInstanceOf(PostgresTranscriptStore);
    expect(stores.checkpoints).toBeInstanceOf(PostgresCheckpointStore);
  });
});

describe('PostgresRunStore', () => {
  let db: ReturnType<typeof createMockDb>;
  let store: PostgresRunStore;

  beforeEach(() => {
    db = createMockDb();
    store = new PostgresRunStore({ db });
  });

  const makeRecord = (id: string, agentId = 'agent-1', state = 'active' as const) => ({
    run: { id, agentId, state, turns: [], createdAt: Date.now() },
    updatedAt: Date.now(),
  });

  it('writes and reads a run record', async () => {
    const rec = makeRecord('run-1');
    await store.write(rec as any);
    const result = await store.read('run-1');
    expect(result).toBeTruthy();
    expect(result!.run.id).toBe('run-1');
  });

  it('returns null for missing run', async () => {
    const result = await store.read('nonexistent');
    expect(result).toBeNull();
  });

  it('lists with filters', async () => {
    await store.write(makeRecord('run-1', 'a', 'active') as any);
    await store.write(makeRecord('run-2', 'b', 'completed') as any);
    await store.write(makeRecord('run-3', 'a', 'completed') as any);

    const all = await store.list();
    expect(all).toHaveLength(3);

    const byAgent = await store.list({ agentId: 'a' });
    expect(byAgent).toHaveLength(2);

    const byState = await store.list({ state: 'completed' });
    expect(byState).toHaveLength(2);

    const limited = await store.list({ limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('deletes a run', async () => {
    await store.write(makeRecord('run-1') as any);
    const deleted = await store.delete('run-1');
    expect(deleted).toBe(true);
    const result = await store.read('run-1');
    expect(result).toBeNull();
  });

  it('returns false when deleting nonexistent', async () => {
    const result = await store.delete('nope');
    expect(result).toBe(false);
  });
});

describe('PostgresThreadStore', () => {
  let db: ReturnType<typeof createMockDb>;
  let store: PostgresThreadStore;

  beforeEach(() => {
    db = createMockDb();
    store = new PostgresThreadStore({ db });
  });

  const makeThread = (id: string) => ({
    id,
    runId: 'run-1',
    agentId: 'agent-1',
    title: 'test',
    state: 'active' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  it('writes and reads a thread', async () => {
    await store.write(makeThread('t-1') as any);
    const result = await store.read('t-1');
    expect(result).toBeTruthy();
    expect(result!.id).toBe('t-1');
  });

  it('deletes a thread', async () => {
    await store.write(makeThread('t-1') as any);
    expect(await store.delete('t-1')).toBe(true);
    expect(await store.read('t-1')).toBeNull();
  });
});

describe('PostgresExecutionGraphStore', () => {
  let store: PostgresExecutionGraphStore;

  beforeEach(() => {
    const db = createMockDb();
    store = new PostgresExecutionGraphStore({ db });
  });

  it('appends nodes and edges, retrieves graph', async () => {
    await store.appendNode({
      id: 'n-1',
      runId: 'run-1',
      kind: 'actor',
      phase: 'execution',
      status: 'success',
      summary: 'test node',
      timestamp: 1000,
    } as any);

    await store.appendEdge({
      id: 'e-1',
      runId: 'run-1',
      from: 'n-1',
      to: 'n-2',
      relation: 'triggered',
      timestamp: 2000,
    } as any);

    const graph = await store.getGraph('run-1');
    expect(graph).toBeTruthy();
    expect(graph!.nodes).toHaveLength(1);
    expect(graph!.edges).toHaveLength(1);
    expect(graph!.receipts).toHaveLength(0);
  });

  it('returns null for empty graph', async () => {
    const graph = await store.getGraph('nonexistent');
    expect(graph).toBeNull();
  });

  it('records and finds receipts by idempotency key', async () => {
    await store.recordReceipt({
      id: 'r-1',
      runId: 'run-1',
      turnIndex: 0,
      capabilityName: 'test',
      idempotencyKey: 'key-1',
      status: 'recorded',
      summary: 'test receipt',
      recordedAt: 1000,
    } as any);

    const found = await store.findReceiptByIdempotencyKey('run-1', 'key-1');
    expect(found).toBeTruthy();
    expect(found!.idempotencyKey).toBe('key-1');

    const notFound = await store.findReceiptByIdempotencyKey('run-1', 'nope');
    expect(notFound).toBeNull();
  });

  it('getRef returns correct counts', async () => {
    await store.appendNode({
      id: 'n-1', runId: 'run-1', kind: 'actor', phase: 'execution',
      status: 'success', summary: 'x', timestamp: 1000,
    } as any);
    await store.appendNode({
      id: 'n-2', runId: 'run-1', kind: 'actor', phase: 'execution',
      status: 'success', summary: 'y', timestamp: 2000,
    } as any);

    const ref = await store.getRef('run-1');
    expect(ref.runId).toBe('run-1');
    expect(ref.nodeCount).toBe(2);
    expect(ref.edgeCount).toBe(0);
    expect(ref.receiptCount).toBe(0);
  });

  it('clears by runId', async () => {
    await store.appendNode({
      id: 'n-1', runId: 'run-1', kind: 'actor', phase: 'execution',
      status: 'success', summary: 'x', timestamp: 1000,
    } as any);
    await store.appendNode({
      id: 'n-2', runId: 'run-2', kind: 'actor', phase: 'execution',
      status: 'success', summary: 'y', timestamp: 2000,
    } as any);

    await store.clear('run-1');

    const graph1 = await store.getGraph('run-1');
    expect(graph1).toBeNull();

    const graph2 = await store.getGraph('run-2');
    expect(graph2).toBeTruthy();
  });
});

describe('PostgresMemoryStore', () => {
  let db: ReturnType<typeof createMockDb>;
  let store: PostgresMemoryStore;

  beforeEach(() => {
    db = createMockDb();
    store = new PostgresMemoryStore({ db });
  });

  const baseEntry = {
    tier: 'working' as const,
    kind: 'note' as const,
    content: 'test memory',
    provenance: 'agent' as const,
    confidence: 0.9,
    scope: 'run' as const,
    ttlMs: 0,
    tags: ['test'],
  };

  it('writes and reads memory entries', async () => {
    const written = await store.write({
      entry: baseEntry,
      overwriteStrategy: 'replace',
    } as any);

    expect(written.id).toMatch(/^mem_/);
    expect(written.content).toBe('test memory');

    const read = await store.read(written.id);
    expect(read).toBeTruthy();
    expect(read!.content).toBe('test memory');
  });

  it('skip strategy skips duplicate content', async () => {
    const first = await store.write({
      entry: baseEntry,
      overwriteStrategy: 'skip',
    } as any);
    const second = await store.write({
      entry: baseEntry,
      overwriteStrategy: 'skip',
    } as any);

    expect(first.id).toBe(second.id);
  });

  it('searches with filters', async () => {
    await store.write({
      entry: { ...baseEntry, content: 'alpha', tags: ['a'] },
      overwriteStrategy: 'replace',
    } as any);
    await store.write({
      entry: { ...baseEntry, content: 'beta', tier: 'episodic', tags: ['b'] },
      overwriteStrategy: 'replace',
    } as any);

    const byTier = await store.search({ tier: 'working' });
    expect(byTier).toHaveLength(1);
    expect(byTier[0].content).toBe('alpha');

    const byText = await store.search({ text: 'beta' });
    expect(byText).toHaveLength(1);

    const byTag = await store.search({ tags: ['a'] });
    expect(byTag).toHaveLength(1);
  });

  it('deletes an entry', async () => {
    const written = await store.write({
      entry: baseEntry,
      overwriteStrategy: 'replace',
    } as any);

    expect(await store.delete(written.id)).toBe(true);
    expect(await store.read(written.id)).toBeNull();
  });

  it('clears by scope', async () => {
    await store.write({
      entry: { ...baseEntry, scope: 'run' },
      overwriteStrategy: 'replace',
    } as any);
    await store.write({
      entry: { ...baseEntry, content: 'global', scope: 'global' },
      overwriteStrategy: 'replace',
    } as any);

    await store.clear('run');

    const remaining = await store.search({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].scope).toBe('global');
  });
});

describe('PostgresTranscriptStore', () => {
  let store: PostgresTranscriptStore;

  beforeEach(() => {
    const db = createMockDb();
    store = new PostgresTranscriptStore({ db });
  });

  const makeEntry = (id: string, runId = 'run-1', kind = 'user_input' as const, ts = Date.now()) => ({
    id,
    runId,
    agentId: 'agent-1',
    kind,
    timestamp: ts,
    content: `content-${id}`,
  });

  it('appends and lists transcript entries', async () => {
    await store.append(makeEntry('e-1', 'run-1', 'user_input', 1000) as any);
    await store.append(makeEntry('e-2', 'run-1', 'model_output', 2000) as any);

    const list = await store.list('run-1');
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('e-1');
    expect(list[1].id).toBe('e-2');
  });

  it('replay filters by kind', async () => {
    await store.append(makeEntry('e-1', 'run-1', 'user_input', 1000) as any);
    await store.append(makeEntry('e-2', 'run-1', 'model_output', 2000) as any);
    await store.append(makeEntry('e-3', 'run-1', 'tool_call', 3000) as any);

    const replayed = await store.replay('run-1', { kinds: ['user_input'] });
    expect(replayed).toHaveLength(1);
    expect(replayed[0].id).toBe('e-1');
  });

  it('clears entries for a run', async () => {
    await store.append(makeEntry('e-1', 'run-1', 'user_input', 1000) as any);
    await store.append(makeEntry('e-2', 'run-2', 'user_input', 2000) as any);

    await store.clear('run-1');

    expect(await store.list('run-1')).toHaveLength(0);
    expect(await store.list('run-2')).toHaveLength(1);
  });

  it('getRef returns correct entry count', async () => {
    await store.append(makeEntry('e-1', 'run-1', 'user_input', 1000) as any);
    await store.append(makeEntry('e-2', 'run-1', 'model_output', 2000) as any);

    const ref = await store.getRef('run-1');
    expect(ref.runId).toBe('run-1');
    expect(ref.entryCount).toBe(2);
    expect(ref.mode).toBe('memory');
  });

  it('replace overwrites all entries for a run', async () => {
    await store.append(makeEntry('e-1', 'run-1', 'user_input', 1000) as any);
    await store.append(makeEntry('e-2', 'run-1', 'model_output', 2000) as any);

    await store.replace('run-1', [makeEntry('e-3', 'run-1', 'tool_call', 3000) as any]);

    const list = await store.list('run-1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('e-3');
  });
});

describe('PostgresCheckpointStore', () => {
  let store: PostgresCheckpointStore;

  beforeEach(() => {
    const db = createMockDb();
    store = new PostgresCheckpointStore({ db });
  });

  const makeCheckpoint = (id: string, runId = 'run-1', ts = Date.now()) => ({
    id,
    runId,
    agentId: 'agent-1',
    turnIndex: 0,
    state: JSON.stringify({ test: true }),
    createdAt: ts,
    reason: 'periodic' as const,
  });

  it('saves and loads a checkpoint', async () => {
    const cp = makeCheckpoint('ckpt-1');
    await store.save(cp);
    const loaded = await store.load('ckpt-1');
    expect(loaded).toBeTruthy();
    expect(loaded!.id).toBe('ckpt-1');
  });

  it('returns null for missing checkpoint', async () => {
    const result = await store.load('nope');
    expect(result).toBeNull();
  });

  it('loads latest checkpoint for a run', async () => {
    await store.save(makeCheckpoint('ckpt-1', 'run-1', 1000));
    await store.save(makeCheckpoint('ckpt-2', 'run-1', 2000));
    await store.save(makeCheckpoint('ckpt-3', 'run-1', 3000));

    const latest = await store.loadLatest('run-1');
    expect(latest).toBeTruthy();
    expect(latest!.id).toBe('ckpt-3');
  });

  it('lists checkpoints for a run', async () => {
    await store.save(makeCheckpoint('ckpt-1', 'run-1', 1000));
    await store.save(makeCheckpoint('ckpt-2', 'run-1', 2000));
    await store.save(makeCheckpoint('ckpt-3', 'run-2', 3000));

    const list = await store.list('run-1');
    expect(list).toHaveLength(2);
  });

  it('deletes a checkpoint', async () => {
    await store.save(makeCheckpoint('ckpt-1'));
    expect(await store.delete('ckpt-1')).toBe(true);
    expect(await store.load('ckpt-1')).toBeNull();
  });

  it('clears checkpoints for a run', async () => {
    await store.save(makeCheckpoint('ckpt-1', 'run-1', 1000));
    await store.save(makeCheckpoint('ckpt-2', 'run-2', 2000));

    await store.clear('run-1');

    expect(await store.load('ckpt-1')).toBeNull();
    expect(await store.load('ckpt-2')).toBeTruthy();
  });
});

describe('Table prefix configuration', () => {
  it('uses custom table prefix', async () => {
    const db = createMockDb();
    const stores = createPostgresStores({ db, tablePrefix: 'myapp_' });

    // Trigger table creation
    await stores.runs.read('test');

    const tableNames = [...db._tables.keys()];
    expect(tableNames.some((t) => t.startsWith('myapp_'))).toBe(true);
  });

  it('rejects invalid table prefix', () => {
    const db = createMockDb();
    expect(() => createPostgresStores({ db, tablePrefix: 'DROP TABLE;' })).toThrow(
      /Invalid.*table prefix/,
    );
  });
});
