/**
 * @packageDocumentation
 * @module PostgresStores
 * @description
 * Postgres-backed implementations of all agent store interfaces.
 * Uses a minimal query executor interface compatible with pg, postgres.js,
 * drizzle, and similar clients.
 *
 * Usage:
 * ```ts
 * import pg from 'pg';
 * import { createPostgresStores } from '@veridex/agents';
 *
 * const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * const stores = await createPostgresStores({ db: pool });
 *
 * const runtime = new AgentRuntime(definition, {
 *   runStore: stores.runs,
 *   threadStore: stores.threads,
 *   executionGraphStore: stores.executionGraphs,
 *   memoryStore: stores.memory,
 *   transcriptStore: stores.transcripts,
 *   checkpointStore: stores.checkpoints,
 * });
 * ```
 */

import type {
  RunStore,
  StoredRunRecord,
  ThreadRecord,
  ThreadStore,
  ExecutionNode,
  ExecutionEdge,
  ExecutionGraph,
  ExecutionGraphRef,
  ExecutionGraphStore,
  SideEffectReceipt,
  IdempotencyKey,
} from '../types/accountability';

import type {
  MemoryStore,
  MemoryEntry,
  MemoryWriteRequest,
  MemoryQuery,
  MemoryScope,
  CompactOptions,
  CompactResult,
} from '../types/memory';

import type {
  TranscriptStore,
  TranscriptEntry,
  TranscriptRef,
  TranscriptReplayOptions,
} from '../types/transcript';

import type { Checkpoint, CheckpointStore } from '../checkpoints/CheckpointManager';

// ── Query executor interface ──

/**
 * Minimal query interface compatible with pg.Pool, pg.Client, postgres.js, etc.
 * Users inject their own driver — we never import pg directly.
 */
export interface PostgresQueryExecutor {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
}

// ── Config ──

export interface PostgresStoreConfig {
  db: PostgresQueryExecutor;
  /** Table name prefix (default: 'veridex_agent_') */
  tablePrefix?: string;
  /** Whether to auto-create tables on first use (default: true) */
  autoMigrate?: boolean;
}

function safeSqlIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}". Only unquoted snake_case identifiers are supported.`,
    );
  }
  return value;
}

// ── Shared migration runner ──

class MigrationTracker {
  private readonly db: PostgresQueryExecutor;
  private readonly prefix: string;
  private readonly autoMigrate: boolean;
  private readonly ready = new Map<string, boolean>();

  constructor(config: PostgresStoreConfig) {
    this.db = config.db;
    this.prefix = safeSqlIdentifier(config.tablePrefix ?? 'veridex_agent_', 'table prefix');
    this.autoMigrate = config.autoMigrate ?? true;
  }

  tableName(suffix: string): string {
    return `${this.prefix}${safeSqlIdentifier(suffix, 'table suffix')}`;
  }

  async ensureTable(suffix: string, ddl: string): Promise<void> {
    if (this.ready.get(suffix)) return;
    if (this.autoMigrate) {
      await this.db.query(ddl, []);
    }
    this.ready.set(suffix, true);
  }
}

// ── RunStore ──

export class PostgresRunStore implements RunStore {
  private readonly db: PostgresQueryExecutor;
  private readonly table: string;
  private readonly migration: MigrationTracker;

  constructor(config: PostgresStoreConfig) {
    this.db = config.db;
    this.migration = new MigrationTracker(config);
    this.table = this.migration.tableName('runs');
  }

  private async ensureTable(): Promise<void> {
    await this.migration.ensureTable(
      'runs',
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        run_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL,
        data JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
    );
  }

  async read(runId: string): Promise<StoredRunRecord | null> {
    await this.ensureTable();
    const result = await this.db.query(
      `SELECT data FROM ${this.table} WHERE run_id = $1`,
      [runId],
    );
    if (result.rows.length === 0) return null;
    return parseJsonb<StoredRunRecord>(result.rows[0].data);
  }

  async write(record: StoredRunRecord): Promise<StoredRunRecord> {
    await this.ensureTable();
    const data = JSON.stringify(record);
    await this.db.query(
      `INSERT INTO ${this.table} (run_id, agent_id, state, data, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (run_id)
       DO UPDATE SET agent_id = $2, state = $3, data = $4::jsonb, updated_at = $5`,
      [record.run.id, record.run.agentId, record.run.state, data, record.updatedAt],
    );
    return record;
  }

  async list(filter?: {
    agentId?: string;
    state?: StoredRunRecord['run']['state'];
    limit?: number;
  }): Promise<StoredRunRecord[]> {
    await this.ensureTable();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filter?.agentId) {
      conditions.push(`agent_id = $${paramIdx++}`);
      params.push(filter.agentId);
    }
    if (filter?.state) {
      conditions.push(`state = $${paramIdx++}`);
      params.push(filter.state);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filter?.limit ? `LIMIT $${paramIdx++}` : '';
    if (filter?.limit) params.push(filter.limit);

    const result = await this.db.query(
      `SELECT data FROM ${this.table} ${where} ORDER BY updated_at DESC ${limitClause}`,
      params,
    );
    return result.rows.map((row) => parseJsonb<StoredRunRecord>(row.data));
  }

  async delete(runId: string): Promise<boolean> {
    await this.ensureTable();
    const result = await this.db.query(
      `DELETE FROM ${this.table} WHERE run_id = $1`,
      [runId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

// ── ThreadStore ──

export class PostgresThreadStore implements ThreadStore {
  private readonly db: PostgresQueryExecutor;
  private readonly table: string;
  private readonly migration: MigrationTracker;

  constructor(config: PostgresStoreConfig) {
    this.db = config.db;
    this.migration = new MigrationTracker(config);
    this.table = this.migration.tableName('threads');
  }

  private async ensureTable(): Promise<void> {
    await this.migration.ensureTable(
      'threads',
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        thread_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        data JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
    );
  }

  async read(threadId: string): Promise<ThreadRecord | null> {
    await this.ensureTable();
    const result = await this.db.query(
      `SELECT data FROM ${this.table} WHERE thread_id = $1`,
      [threadId],
    );
    if (result.rows.length === 0) return null;
    return parseJsonb<ThreadRecord>(result.rows[0].data);
  }

  async write(record: ThreadRecord): Promise<ThreadRecord> {
    await this.ensureTable();
    const data = JSON.stringify(record);
    await this.db.query(
      `INSERT INTO ${this.table} (thread_id, agent_id, run_id, state, data, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (thread_id)
       DO UPDATE SET agent_id = $2, run_id = $3, state = $4, data = $5::jsonb, updated_at = $6`,
      [record.id, record.agentId, record.runId, record.state, data, record.updatedAt],
    );
    return record;
  }

  async list(filter?: {
    agentId?: string;
    state?: ThreadRecord['state'];
    limit?: number;
  }): Promise<ThreadRecord[]> {
    await this.ensureTable();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filter?.agentId) {
      conditions.push(`agent_id = $${paramIdx++}`);
      params.push(filter.agentId);
    }
    if (filter?.state) {
      conditions.push(`state = $${paramIdx++}`);
      params.push(filter.state);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filter?.limit ? `LIMIT $${paramIdx++}` : '';
    if (filter?.limit) params.push(filter.limit);

    const result = await this.db.query(
      `SELECT data FROM ${this.table} ${where} ORDER BY updated_at DESC ${limitClause}`,
      params,
    );
    return result.rows.map((row) => parseJsonb<ThreadRecord>(row.data));
  }

  async delete(threadId: string): Promise<boolean> {
    await this.ensureTable();
    const result = await this.db.query(
      `DELETE FROM ${this.table} WHERE thread_id = $1`,
      [threadId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

// ── ExecutionGraphStore ──

export class PostgresExecutionGraphStore implements ExecutionGraphStore {
  private readonly db: PostgresQueryExecutor;
  private readonly nodesTable: string;
  private readonly edgesTable: string;
  private readonly receiptsTable: string;
  private readonly migration: MigrationTracker;

  constructor(config: PostgresStoreConfig) {
    this.db = config.db;
    this.migration = new MigrationTracker(config);
    this.nodesTable = this.migration.tableName('exec_nodes');
    this.edgesTable = this.migration.tableName('exec_edges');
    this.receiptsTable = this.migration.tableName('exec_receipts');
  }

  private async ensureTables(): Promise<void> {
    await this.migration.ensureTable(
      'exec_nodes',
      `CREATE TABLE IF NOT EXISTS ${this.nodesTable} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        data JSONB NOT NULL,
        timestamp BIGINT NOT NULL
      )`,
    );
    await this.migration.ensureTable(
      'exec_edges',
      `CREATE TABLE IF NOT EXISTS ${this.edgesTable} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        data JSONB NOT NULL,
        timestamp BIGINT NOT NULL
      )`,
    );
    await this.migration.ensureTable(
      'exec_receipts',
      `CREATE TABLE IF NOT EXISTS ${this.receiptsTable} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        idempotency_key TEXT,
        data JSONB NOT NULL,
        recorded_at BIGINT NOT NULL
      )`,
    );
  }

  async appendNode(node: ExecutionNode): Promise<ExecutionNode> {
    await this.ensureTables();
    await this.db.query(
      `INSERT INTO ${this.nodesTable} (id, run_id, data, timestamp)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (id) DO UPDATE SET data = $3::jsonb, timestamp = $4`,
      [node.id, node.runId, JSON.stringify(node), node.timestamp],
    );
    return node;
  }

  async appendEdge(edge: ExecutionEdge): Promise<ExecutionEdge> {
    await this.ensureTables();
    await this.db.query(
      `INSERT INTO ${this.edgesTable} (id, run_id, data, timestamp)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (id) DO UPDATE SET data = $3::jsonb, timestamp = $4`,
      [edge.id, edge.runId, JSON.stringify(edge), edge.timestamp],
    );
    return edge;
  }

  async recordReceipt(receipt: SideEffectReceipt): Promise<SideEffectReceipt> {
    await this.ensureTables();
    await this.db.query(
      `INSERT INTO ${this.receiptsTable} (id, run_id, idempotency_key, data, recorded_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (id) DO UPDATE SET data = $4::jsonb, recorded_at = $5`,
      [
        receipt.id,
        receipt.runId,
        receipt.idempotencyKey,
        JSON.stringify(receipt),
        receipt.recordedAt,
      ],
    );
    return receipt;
  }

  async getGraph(runId: string): Promise<ExecutionGraph | null> {
    await this.ensureTables();
    const [nodesResult, edgesResult, receiptsResult] = await Promise.all([
      this.db.query(
        `SELECT data FROM ${this.nodesTable} WHERE run_id = $1 ORDER BY timestamp`,
        [runId],
      ),
      this.db.query(
        `SELECT data FROM ${this.edgesTable} WHERE run_id = $1 ORDER BY timestamp`,
        [runId],
      ),
      this.db.query(
        `SELECT data FROM ${this.receiptsTable} WHERE run_id = $1 ORDER BY recorded_at`,
        [runId],
      ),
    ]);

    const nodes = nodesResult.rows.map((r) => parseJsonb<ExecutionNode>(r.data));
    const edges = edgesResult.rows.map((r) => parseJsonb<ExecutionEdge>(r.data));
    const receipts = receiptsResult.rows.map((r) => parseJsonb<SideEffectReceipt>(r.data));

    if (nodes.length === 0 && edges.length === 0 && receipts.length === 0) {
      return null;
    }

    const timestamps = [
      ...nodes.map((n) => n.timestamp),
      ...edges.map((e) => e.timestamp),
      ...receipts.map((r) => r.recordedAt),
    ];

    return {
      runId,
      nodes,
      edges,
      receipts,
      createdAt: Math.min(...timestamps),
      updatedAt: Math.max(...timestamps),
    };
  }

  async getRef(runId: string): Promise<ExecutionGraphRef> {
    await this.ensureTables();
    const [nodesResult, edgesResult, receiptsResult] = await Promise.all([
      this.db.query(
        `SELECT COUNT(*) as cnt FROM ${this.nodesTable} WHERE run_id = $1`,
        [runId],
      ),
      this.db.query(
        `SELECT COUNT(*) as cnt FROM ${this.edgesTable} WHERE run_id = $1`,
        [runId],
      ),
      this.db.query(
        `SELECT COUNT(*) as cnt FROM ${this.receiptsTable} WHERE run_id = $1`,
        [runId],
      ),
    ]);

    return {
      runId,
      nodeCount: Number(nodesResult.rows[0]?.cnt ?? 0),
      edgeCount: Number(edgesResult.rows[0]?.cnt ?? 0),
      receiptCount: Number(receiptsResult.rows[0]?.cnt ?? 0),
    };
  }

  async findReceiptByIdempotencyKey(
    runId: string,
    idempotencyKey: IdempotencyKey,
  ): Promise<SideEffectReceipt | null> {
    await this.ensureTables();
    const result = await this.db.query(
      `SELECT data FROM ${this.receiptsTable} WHERE run_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [runId, idempotencyKey],
    );
    if (result.rows.length === 0) return null;
    return parseJsonb<SideEffectReceipt>(result.rows[0].data);
  }

  async clear(runId?: string): Promise<void> {
    await this.ensureTables();
    if (runId) {
      await Promise.all([
        this.db.query(`DELETE FROM ${this.nodesTable} WHERE run_id = $1`, [runId]),
        this.db.query(`DELETE FROM ${this.edgesTable} WHERE run_id = $1`, [runId]),
        this.db.query(`DELETE FROM ${this.receiptsTable} WHERE run_id = $1`, [runId]),
      ]);
    } else {
      await Promise.all([
        this.db.query(`DELETE FROM ${this.nodesTable}`, []),
        this.db.query(`DELETE FROM ${this.edgesTable}`, []),
        this.db.query(`DELETE FROM ${this.receiptsTable}`, []),
      ]);
    }
  }
}

// ── MemoryStore ──

export class PostgresMemoryStore implements MemoryStore {
  private readonly db: PostgresQueryExecutor;
  private readonly table: string;
  private readonly migration: MigrationTracker;
  private counter = 0;

  constructor(config: PostgresStoreConfig) {
    this.db = config.db;
    this.migration = new MigrationTracker(config);
    this.table = this.migration.tableName('memory');
  }

  private async ensureTable(): Promise<void> {
    await this.migration.ensureTable(
      'memory',
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        kind TEXT,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        provenance TEXT NOT NULL,
        confidence REAL NOT NULL,
        ttl_ms BIGINT NOT NULL DEFAULT 0,
        tags TEXT[] NOT NULL DEFAULT '{}',
        created_at BIGINT NOT NULL,
        last_accessed_at BIGINT NOT NULL,
        data JSONB NOT NULL
      )`,
    );
  }

  async read(id: string): Promise<MemoryEntry | null> {
    await this.ensureTable();
    const result = await this.db.query(
      `SELECT data, created_at, ttl_ms FROM ${this.table} WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const createdAt = Number(row.created_at);
    const ttlMs = Number(row.ttl_ms);

    // Check TTL
    if (ttlMs > 0 && Date.now() - createdAt > ttlMs) {
      await this.delete(id);
      return null;
    }

    // Update last accessed
    const now = Date.now();
    await this.db.query(
      `UPDATE ${this.table} SET last_accessed_at = $1 WHERE id = $2`,
      [now, id],
    );

    const entry = parseJsonb<MemoryEntry>(row.data);
    entry.lastAccessedAt = now;
    return entry;
  }

  async write(request: MemoryWriteRequest): Promise<MemoryEntry> {
    await this.ensureTable();
    const { entry: partial, overwriteStrategy } = request;

    // Check for existing entry with same content (unless replace)
    if (overwriteStrategy !== 'replace') {
      const existing = await this.db.query(
        `SELECT data FROM ${this.table} WHERE content = $1 AND tier = $2 LIMIT 1`,
        [partial.content, partial.tier],
      );

      if (existing.rows.length > 0) {
        const existingEntry = parseJsonb<MemoryEntry>(existing.rows[0].data);

        switch (overwriteStrategy) {
          case 'skip':
            return existingEntry;
          case 'merge': {
            existingEntry.confidence = Math.max(existingEntry.confidence, partial.confidence);
            existingEntry.tags = [...new Set([...existingEntry.tags, ...partial.tags])];
            existingEntry.kind = partial.kind ?? existingEntry.kind;
            existingEntry.stateRef = partial.stateRef ?? existingEntry.stateRef;
            existingEntry.evidenceRef = partial.evidenceRef ?? existingEntry.evidenceRef;
            existingEntry.derivation = partial.derivation ?? existingEntry.derivation;
            existingEntry.lastAccessedAt = Date.now();
            await this.upsertEntry(existingEntry);
            return existingEntry;
          }
          case 'append':
            break; // Fall through to create new
        }
      }
    }

    const now = Date.now();
    const entry: MemoryEntry = {
      ...partial,
      id: `mem_${++this.counter}_${now}`,
      createdAt: now,
      lastAccessedAt: now,
    };

    await this.upsertEntry(entry);
    return entry;
  }

  private async upsertEntry(entry: MemoryEntry): Promise<void> {
    const data = JSON.stringify(entry);
    await this.db.query(
      `INSERT INTO ${this.table}
        (id, tier, kind, scope, content, provenance, confidence, ttl_ms, tags, created_at, last_accessed_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (id)
       DO UPDATE SET
        tier = $2, kind = $3, scope = $4, content = $5, provenance = $6,
        confidence = $7, ttl_ms = $8, tags = $9, last_accessed_at = $11, data = $12::jsonb`,
      [
        entry.id,
        entry.tier,
        entry.kind ?? null,
        entry.scope,
        entry.content,
        entry.provenance,
        entry.confidence,
        entry.ttlMs,
        entry.tags,
        entry.createdAt,
        entry.lastAccessedAt,
        data,
      ],
    );
  }

  async search(query: MemoryQuery): Promise<MemoryEntry[]> {
    await this.ensureTable();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    // Exclude expired
    conditions.push(`(ttl_ms = 0 OR (created_at + ttl_ms) > $${paramIdx++})`);
    params.push(Date.now());

    if (query.tier) {
      conditions.push(`tier = $${paramIdx++}`);
      params.push(query.tier);
    }
    if (query.kind) {
      conditions.push(`kind = $${paramIdx++}`);
      params.push(query.kind);
    }
    if (query.scope) {
      conditions.push(`scope = $${paramIdx++}`);
      params.push(query.scope);
    }
    if (query.minConfidence !== undefined) {
      conditions.push(`confidence >= $${paramIdx++}`);
      params.push(query.minConfidence);
    }
    if (query.newerThan !== undefined) {
      conditions.push(`created_at >= $${paramIdx++}`);
      params.push(query.newerThan);
    }
    if (query.tags?.length) {
      conditions.push(`tags && $${paramIdx++}`);
      params.push(query.tags);
    }
    if (query.text) {
      conditions.push(`content ILIKE $${paramIdx++}`);
      params.push(`%${escapeLike(query.text)}%`);
    }

    // resourceType / resourceId need JSONB filtering
    if (query.resourceType) {
      conditions.push(`data->'stateRef'->>'resourceType' = $${paramIdx++}`);
      params.push(query.resourceType);
    }
    if (query.resourceId) {
      conditions.push(`data->'stateRef'->>'resourceId' = $${paramIdx++}`);
      params.push(query.resourceId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = query.limit ? `LIMIT $${paramIdx++}` : '';
    if (query.limit) params.push(query.limit);

    const result = await this.db.query(
      `SELECT id, data FROM ${this.table} ${where} ORDER BY created_at DESC ${limitClause}`,
      params,
    );

    // Update last accessed for returned entries
    const now = Date.now();
    const ids = result.rows.map((r) => r.id as string);
    if (ids.length > 0) {
      await this.db.query(
        `UPDATE ${this.table} SET last_accessed_at = $1 WHERE id = ANY($2)`,
        [now, ids],
      );
    }

    return result.rows.map((row) => {
      const entry = parseJsonb<MemoryEntry>(row.data);
      entry.lastAccessedAt = now;
      return entry;
    });
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureTable();
    const result = await this.db.query(
      `DELETE FROM ${this.table} WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async compact(options?: CompactOptions): Promise<CompactResult> {
    await this.ensureTable();
    let removed = 0;
    const now = Date.now();

    // Remove expired
    const expiredResult = await this.db.query(
      `DELETE FROM ${this.table} WHERE ttl_ms > 0 AND (created_at + ttl_ms) < $1`,
      [now],
    );
    removed += expiredResult.rowCount ?? 0;

    // Remove older than
    if (options?.olderThan) {
      const olderResult = await this.db.query(
        `DELETE FROM ${this.table} WHERE created_at < $1`,
        [options.olderThan],
      );
      removed += olderResult.rowCount ?? 0;
    }

    // Remove below confidence
    if (options?.belowConfidence !== undefined) {
      const confResult = await this.db.query(
        `DELETE FROM ${this.table} WHERE confidence < $1`,
        [options.belowConfidence],
      );
      removed += confResult.rowCount ?? 0;
    }

    // Enforce max per tier
    if (options?.maxPerTier) {
      const tiers = ['working', 'episodic', 'semantic', 'procedural'];
      for (const tier of tiers) {
        const countResult = await this.db.query(
          `SELECT COUNT(*) as cnt FROM ${this.table} WHERE tier = $1`,
          [tier],
        );
        const count = Number(countResult.rows[0]?.cnt ?? 0);
        if (count > options.maxPerTier) {
          const excess = count - options.maxPerTier;
          const deleteResult = await this.db.query(
            `DELETE FROM ${this.table} WHERE id IN (
              SELECT id FROM ${this.table} WHERE tier = $1
              ORDER BY last_accessed_at ASC LIMIT $2
            )`,
            [tier, excess],
          );
          removed += deleteResult.rowCount ?? 0;
        }
      }
    }

    return { removed, merged: 0, archived: 0 };
  }

  async clear(scope?: MemoryScope): Promise<void> {
    await this.ensureTable();
    if (!scope) {
      await this.db.query(`DELETE FROM ${this.table}`, []);
    } else {
      await this.db.query(`DELETE FROM ${this.table} WHERE scope = $1`, [scope]);
    }
  }
}

// ── TranscriptStore ──

export class PostgresTranscriptStore implements TranscriptStore {
  readonly mode = 'memory' as const; // Postgres acts as durable "memory" mode

  private readonly db: PostgresQueryExecutor;
  private readonly table: string;
  private readonly migration: MigrationTracker;

  constructor(config: PostgresStoreConfig) {
    this.db = config.db;
    this.migration = new MigrationTracker(config);
    this.table = this.migration.tableName('transcripts');
  }

  private async ensureTable(): Promise<void> {
    await this.migration.ensureTable(
      'transcripts',
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        turn_index INTEGER,
        timestamp BIGINT NOT NULL,
        content TEXT NOT NULL,
        data JSONB NOT NULL
      )`,
    );
  }

  async append(entry: TranscriptEntry): Promise<void> {
    await this.ensureTable();
    await this.db.query(
      `INSERT INTO ${this.table} (id, run_id, agent_id, kind, turn_index, timestamp, content, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        entry.id,
        entry.runId,
        entry.agentId,
        entry.kind,
        entry.turnIndex ?? null,
        entry.timestamp,
        entry.content,
        JSON.stringify(entry),
      ],
    );
  }

  async appendMany(entries: TranscriptEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.append(entry);
    }
  }

  async list(runId: string): Promise<TranscriptEntry[]> {
    await this.ensureTable();
    const result = await this.db.query(
      `SELECT data FROM ${this.table} WHERE run_id = $1 ORDER BY timestamp ASC`,
      [runId],
    );
    return result.rows.map((row) => parseJsonb<TranscriptEntry>(row.data));
  }

  async replay(
    runId: string,
    options?: TranscriptReplayOptions,
  ): Promise<TranscriptEntry[]> {
    await this.ensureTable();
    const conditions: string[] = ['run_id = $1'];
    const params: unknown[] = [runId];
    let paramIdx = 2;

    if (options?.kinds?.length) {
      conditions.push(`kind = ANY($${paramIdx++})`);
      params.push(options.kinds);
    }
    if (options?.sinceTimestamp !== undefined) {
      conditions.push(`timestamp >= $${paramIdx++}`);
      params.push(options.sinceTimestamp);
    }
    if (options?.turnIndex !== undefined) {
      conditions.push(`turn_index = $${paramIdx++}`);
      params.push(options.turnIndex);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const orderAndLimit = options?.limit
      ? `ORDER BY timestamp DESC LIMIT $${paramIdx++}`
      : 'ORDER BY timestamp ASC';
    if (options?.limit) params.push(options.limit);

    const result = await this.db.query(
      `SELECT data FROM ${this.table} ${where} ${orderAndLimit}`,
      params,
    );

    let entries = result.rows.map((row) => parseJsonb<TranscriptEntry>(row.data));

    // If we limited with DESC ordering, reverse to get ASC
    if (options?.limit) {
      entries = entries.reverse();
    }

    return entries;
  }

  async compact(runId: string, keepLast = 50): Promise<void> {
    await this.ensureTable();
    // Delete all but the last N entries for this run
    await this.db.query(
      `DELETE FROM ${this.table} WHERE run_id = $1 AND id NOT IN (
        SELECT id FROM ${this.table} WHERE run_id = $1
        ORDER BY timestamp DESC LIMIT $2
      )`,
      [runId, keepLast],
    );
  }

  async replace(runId: string, entries: TranscriptEntry[]): Promise<void> {
    await this.ensureTable();
    await this.db.query(`DELETE FROM ${this.table} WHERE run_id = $1`, [runId]);
    for (const entry of entries) {
      await this.append(entry);
    }
  }

  async clear(runId?: string): Promise<void> {
    await this.ensureTable();
    if (runId) {
      await this.db.query(`DELETE FROM ${this.table} WHERE run_id = $1`, [runId]);
    } else {
      await this.db.query(`DELETE FROM ${this.table}`, []);
    }
  }

  async getRef(runId: string): Promise<TranscriptRef> {
    await this.ensureTable();
    const result = await this.db.query(
      `SELECT COUNT(*) as cnt, MAX(timestamp) as last_ts FROM ${this.table} WHERE run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return {
      runId,
      mode: this.mode,
      entryCount: Number(row?.cnt ?? 0),
      lastUpdatedAt: row?.last_ts ? Number(row.last_ts) : undefined,
    };
  }
}

// ── CheckpointStore ──

export class PostgresCheckpointStore implements CheckpointStore {
  private readonly db: PostgresQueryExecutor;
  private readonly table: string;
  private readonly migration: MigrationTracker;

  constructor(config: PostgresStoreConfig) {
    this.db = config.db;
    this.migration = new MigrationTracker(config);
    this.table = this.migration.tableName('checkpoints');
  }

  private async ensureTable(): Promise<void> {
    await this.migration.ensureTable(
      'checkpoints',
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        reason TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        data JSONB NOT NULL
      )`,
    );
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    await this.ensureTable();
    await this.db.query(
      `INSERT INTO ${this.table} (id, run_id, agent_id, turn_index, reason, state, created_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (id) DO UPDATE SET state = $6, created_at = $7, data = $8::jsonb`,
      [
        checkpoint.id,
        checkpoint.runId,
        checkpoint.agentId,
        checkpoint.turnIndex,
        checkpoint.reason,
        checkpoint.state,
        checkpoint.createdAt,
        JSON.stringify(checkpoint),
      ],
    );
  }

  async load(id: string): Promise<Checkpoint | null> {
    await this.ensureTable();
    const result = await this.db.query(
      `SELECT data FROM ${this.table} WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return parseJsonb<Checkpoint>(result.rows[0].data);
  }

  async loadLatest(runId: string): Promise<Checkpoint | null> {
    await this.ensureTable();
    const result = await this.db.query(
      `SELECT data FROM ${this.table} WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [runId],
    );
    if (result.rows.length === 0) return null;
    return parseJsonb<Checkpoint>(result.rows[0].data);
  }

  async list(runId: string): Promise<Checkpoint[]> {
    await this.ensureTable();
    const result = await this.db.query(
      `SELECT data FROM ${this.table} WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId],
    );
    return result.rows.map((row) => parseJsonb<Checkpoint>(row.data));
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureTable();
    const result = await this.db.query(
      `DELETE FROM ${this.table} WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async clear(runId?: string): Promise<void> {
    await this.ensureTable();
    if (runId) {
      await this.db.query(`DELETE FROM ${this.table} WHERE run_id = $1`, [runId]);
    } else {
      await this.db.query(`DELETE FROM ${this.table}`, []);
    }
  }
}

// ── Factory ──

export interface PostgresStores {
  runs: PostgresRunStore;
  threads: PostgresThreadStore;
  executionGraphs: PostgresExecutionGraphStore;
  memory: PostgresMemoryStore;
  transcripts: PostgresTranscriptStore;
  checkpoints: PostgresCheckpointStore;
}

/**
 * Create all Postgres-backed stores with shared config.
 * Tables are auto-created on first use by default.
 */
export function createPostgresStores(config: PostgresStoreConfig): PostgresStores {
  return {
    runs: new PostgresRunStore(config),
    threads: new PostgresThreadStore(config),
    executionGraphs: new PostgresExecutionGraphStore(config),
    memory: new PostgresMemoryStore(config),
    transcripts: new PostgresTranscriptStore(config),
    checkpoints: new PostgresCheckpointStore(config),
  };
}

// ── Utilities ──

function parseJsonb<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function escapeLike(text: string): string {
  return text.replace(/[%_\\]/g, '\\$&');
}
