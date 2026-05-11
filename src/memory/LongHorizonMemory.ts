/**
 * @packageDocumentation
 * @module LongHorizonMemory
 * @description
 * Letta-tier long-horizon memory primitives. Built on top of the existing
 * tiered `MemoryManager` for agents that maintain coherence across days
 * or weeks of work.
 *
 * Three concerns, three primitives:
 *
 *   1. **Episodes** — bounded units of work (a session, a task, a run).
 *      `EpisodicMemoryStore` records each one, retrieves them by time
 *      window or actor, and compresses old ones into summaries the model
 *      can still reason about without re-reading the raw history.
 *
 *   2. **Entities** — canonical references for the people, projects,
 *      systems, addresses, etc. an agent encounters repeatedly.
 *      `EntityRegistry` resolves aliases ("the user" → user_42), tracks
 *      first-seen / last-seen, and lets memory queries pivot off a
 *      stable id rather than free-text.
 *
 *   3. **Temporal relations** — facts that have a validity window
 *      ("Alice was the project owner from T1 to T2"). `TemporalGraph`
 *      stores these as time-bounded edges so an agent can ask "who
 *      owned project X in March" and not hallucinate the answer from
 *      the latest record.
 *
 * The interfaces are deliberately minimal so customers can swap in
 * Letta / Zep / a vector store when scale demands it. The in-memory
 * implementations ship as the "good enough to start" default.
 */

// ═════════════════════════════════════════════════════════════════════════
// Episodes
// ═════════════════════════════════════════════════════════════════════════

/**
 * A bounded unit of agent work — a run, a session, a task.
 *
 * Episodes are the unit of episodic compression: once an episode is
 * "closed" (the work finished or rolled into a higher-level episode),
 * a summarizer can compress its raw transcript into a structured summary
 * that survives in long-term memory while the raw transcript is archived.
 */
export interface Episode {
  /** Stable id. Recommended: prefix by kind (`run_…`, `task_…`). */
  id: string;
  /** Optional parent episode (a task within a session, a session within a project). */
  parentId?: string;
  /** Human-readable label for retrieval and UI display. */
  label: string;
  /** Episode kind. Free-form, recommended: 'run' | 'task' | 'session' | 'project'. */
  kind: string;
  /** Wall-clock start, ms epoch. */
  startedAt: number;
  /** Wall-clock end, ms epoch. Unset while the episode is still open. */
  endedAt?: number;
  /** Canonical entity ids referenced in this episode (resolved via `EntityRegistry`). */
  entityIds?: string[];
  /** Compressed summary written by the summariser. Replaces raw transcript at retrieval time. */
  summary?: string;
  /** Salient facts the summariser thought worth surfacing — preserved verbatim. */
  highlights?: string[];
  /** Free-form metadata for the host. */
  metadata?: Record<string, unknown>;
}

/** Selection criteria for `EpisodicMemoryStore.query`. */
export interface EpisodeQuery {
  /** Restrict by parent episode (e.g. all tasks in a session). */
  parentId?: string;
  /** Restrict by kind. */
  kind?: string;
  /** Episodes that overlap this window. Either bound is optional. */
  startedAfter?: number;
  startedBefore?: number;
  /** Restrict by entity participation (any id matches). */
  entityId?: string;
  /** Restrict to compressed/uncompressed. Useful for compactor passes. */
  compressed?: boolean;
  /** Hard cap on returned rows. Defaults to 100. */
  limit?: number;
}

/**
 * Strategy interface for compressing closed episodes into summaries.
 *
 * Customers plug in an LLM-backed summariser; the in-memory default
 * concatenates highlights so behaviour is deterministic in tests.
 */
export interface EpisodeSummariser {
  summarise(episode: Episode, raw: string[]): Promise<{
    summary: string;
    highlights?: string[];
  }>;
}

export interface EpisodicMemoryStore {
  /** Open a new episode. The store assigns timestamps if omitted. */
  open(input: Omit<Episode, 'startedAt' | 'endedAt'> & { startedAt?: number }): Promise<Episode>;
  /** Close an episode. Optionally attaches summary/highlights eagerly. */
  close(id: string, patch?: Partial<Pick<Episode, 'summary' | 'highlights' | 'metadata' | 'entityIds'>>): Promise<Episode>;
  /** Read a single episode. */
  get(id: string): Promise<Episode | null>;
  /** Query episodes. Results are ordered by `startedAt` desc. */
  query(q?: EpisodeQuery): Promise<Episode[]>;
  /**
   * Compress closed episodes that match the predicate. Calls the
   * summariser, writes back `summary` + `highlights`, and discards the
   * raw lines via `archiveRaw` (host-supplied). Returns the ids touched.
   */
  compress(opts: {
    summariser: EpisodeSummariser;
    /** Optional filter; defaults to all closed, uncompressed episodes. */
    where?: EpisodeQuery;
    /** Host-provided fetch of raw lines for the episode being compressed. */
    fetchRaw: (episodeId: string) => Promise<string[]>;
    /** Host-provided archival of raw lines once compression succeeds. */
    archiveRaw?: (episodeId: string, raw: string[]) => Promise<void>;
  }): Promise<string[]>;
}

/** In-memory episodic store. Suitable for tests and single-process runtimes. */
export class InMemoryEpisodicStore implements EpisodicMemoryStore {
  private episodes = new Map<string, Episode>();

  async open(input: Omit<Episode, 'startedAt' | 'endedAt'> & { startedAt?: number }): Promise<Episode> {
    if (this.episodes.has(input.id)) {
      throw new Error(`Episode '${input.id}' already exists`);
    }
    const ep: Episode = {
      ...input,
      startedAt: input.startedAt ?? Date.now(),
    };
    this.episodes.set(ep.id, ep);
    return { ...ep };
  }

  async close(id: string, patch: Partial<Pick<Episode, 'summary' | 'highlights' | 'metadata' | 'entityIds'>> = {}): Promise<Episode> {
    const existing = this.episodes.get(id);
    if (!existing) throw new Error(`Episode '${id}' not found`);
    const closed: Episode = {
      ...existing,
      ...patch,
      endedAt: existing.endedAt ?? Date.now(),
    };
    this.episodes.set(id, closed);
    return { ...closed };
  }

  async get(id: string): Promise<Episode | null> {
    const ep = this.episodes.get(id);
    return ep ? { ...ep } : null;
  }

  async query(q: EpisodeQuery = {}): Promise<Episode[]> {
    const limit = q.limit ?? 100;
    const rows = Array.from(this.episodes.values())
      .filter((ep) => {
        if (q.parentId !== undefined && ep.parentId !== q.parentId) return false;
        if (q.kind !== undefined && ep.kind !== q.kind) return false;
        if (q.startedAfter !== undefined && ep.startedAt < q.startedAfter) return false;
        if (q.startedBefore !== undefined && ep.startedAt > q.startedBefore) return false;
        if (q.entityId !== undefined && !(ep.entityIds ?? []).includes(q.entityId)) return false;
        if (q.compressed === true && !ep.summary) return false;
        if (q.compressed === false && ep.summary) return false;
        return true;
      })
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
    return rows.map((r) => ({ ...r }));
  }

  async compress(opts: {
    summariser: EpisodeSummariser;
    where?: EpisodeQuery;
    fetchRaw: (episodeId: string) => Promise<string[]>;
    archiveRaw?: (episodeId: string, raw: string[]) => Promise<void>;
  }): Promise<string[]> {
    const candidates = await this.query({ ...opts.where, compressed: false });
    const closed = candidates.filter((ep) => ep.endedAt !== undefined);
    const touched: string[] = [];
    for (const ep of closed) {
      const raw = await opts.fetchRaw(ep.id);
      const { summary, highlights } = await opts.summariser.summarise(ep, raw);
      const next: Episode = { ...ep, summary, highlights };
      this.episodes.set(ep.id, next);
      if (opts.archiveRaw) await opts.archiveRaw(ep.id, raw);
      touched.push(ep.id);
    }
    return touched;
  }
}

/**
 * Deterministic summariser used as a fallback / in tests. Concatenates
 * highlights and the first/last raw lines so the output is stable.
 */
export class HighlightConcatenatingSummariser implements EpisodeSummariser {
  async summarise(episode: Episode, raw: string[]): Promise<{ summary: string; highlights?: string[] }> {
    const head = raw.slice(0, 2);
    const tail = raw.length > 4 ? raw.slice(-2) : [];
    const summary = [
      `Episode "${episode.label}" (${episode.kind})`,
      ...(episode.highlights ?? []).map((h) => `- ${h}`),
      ...head,
      tail.length ? `…${raw.length - 4} lines elided…` : '',
      ...tail,
    ]
      .filter(Boolean)
      .join('\n');
    return { summary, highlights: episode.highlights };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Entities
// ═════════════════════════════════════════════════════════════════════════

/** A canonical entity tracked across episodes. */
export interface Entity {
  /** Stable canonical id. */
  id: string;
  /** Entity kind. Recommended: 'person' | 'project' | 'system' | 'wallet' | 'org'. */
  kind: string;
  /** Display name. */
  name: string;
  /** Aliases the entity may be referred to by ("the user", "alice@x.com"). */
  aliases: string[];
  /** First time the agent saw this entity, ms epoch. */
  firstSeenAt: number;
  /** Most recent observation, ms epoch. */
  lastSeenAt: number;
  /** Free-form metadata. */
  metadata?: Record<string, unknown>;
}

export interface EntityRegistry {
  /** Look up a canonical entity by alias. Case-insensitive match. */
  resolve(alias: string): Promise<Entity | null>;
  /** Read a canonical entity. */
  get(id: string): Promise<Entity | null>;
  /**
   * Idempotently upsert an entity. If `aliases` overlap an existing
   * entity, the existing record is updated and returned.
   */
  upsert(entity: Omit<Entity, 'firstSeenAt' | 'lastSeenAt'> & {
    firstSeenAt?: number;
    lastSeenAt?: number;
  }): Promise<Entity>;
  /** Add aliases to an existing entity. */
  addAlias(id: string, alias: string): Promise<Entity>;
  /** List entities, optionally filtered by kind. */
  list(filter?: { kind?: string; limit?: number }): Promise<Entity[]>;
}

/** In-memory entity registry. Alias matching is case-insensitive substring-equal. */
export class InMemoryEntityRegistry implements EntityRegistry {
  private byId = new Map<string, Entity>();
  private aliasIndex = new Map<string, string>(); // lowercase alias -> entity id

  async resolve(alias: string): Promise<Entity | null> {
    const id = this.aliasIndex.get(alias.toLowerCase().trim());
    if (!id) return null;
    const e = this.byId.get(id);
    return e ? { ...e } : null;
  }

  async get(id: string): Promise<Entity | null> {
    const e = this.byId.get(id);
    return e ? { ...e } : null;
  }

  async upsert(entity: Omit<Entity, 'firstSeenAt' | 'lastSeenAt'> & {
    firstSeenAt?: number;
    lastSeenAt?: number;
  }): Promise<Entity> {
    const now = Date.now();
    const aliases = [entity.name, ...entity.aliases]
      .map((a) => a.toLowerCase().trim())
      .filter(Boolean);

    // Look for an existing entity by alias overlap.
    let existingId: string | undefined;
    for (const a of aliases) {
      const id = this.aliasIndex.get(a);
      if (id) {
        existingId = id;
        break;
      }
    }
    if (existingId) {
      const existing = this.byId.get(existingId)!;
      const merged: Entity = {
        ...existing,
        kind: entity.kind || existing.kind,
        name: entity.name || existing.name,
        aliases: Array.from(new Set([...existing.aliases, ...entity.aliases])),
        lastSeenAt: entity.lastSeenAt ?? now,
        metadata: { ...(existing.metadata ?? {}), ...(entity.metadata ?? {}) },
      };
      this.byId.set(existingId, merged);
      for (const a of merged.aliases.map((x) => x.toLowerCase().trim())) {
        this.aliasIndex.set(a, existingId);
      }
      this.aliasIndex.set(merged.name.toLowerCase().trim(), existingId);
      return { ...merged };
    }

    const fresh: Entity = {
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      aliases: entity.aliases,
      firstSeenAt: entity.firstSeenAt ?? now,
      lastSeenAt: entity.lastSeenAt ?? now,
      metadata: entity.metadata,
    };
    this.byId.set(fresh.id, fresh);
    for (const a of aliases) this.aliasIndex.set(a, fresh.id);
    return { ...fresh };
  }

  async addAlias(id: string, alias: string): Promise<Entity> {
    const existing = this.byId.get(id);
    if (!existing) throw new Error(`Entity '${id}' not found`);
    const normalized = alias.toLowerCase().trim();
    if (this.aliasIndex.has(normalized) && this.aliasIndex.get(normalized) !== id) {
      throw new Error(`Alias '${alias}' already resolves to a different entity`);
    }
    const next: Entity = {
      ...existing,
      aliases: Array.from(new Set([...existing.aliases, alias])),
      lastSeenAt: Date.now(),
    };
    this.byId.set(id, next);
    this.aliasIndex.set(normalized, id);
    return { ...next };
  }

  async list(filter: { kind?: string; limit?: number } = {}): Promise<Entity[]> {
    const limit = filter.limit ?? 100;
    return Array.from(this.byId.values())
      .filter((e) => (filter.kind ? e.kind === filter.kind : true))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Temporal graph
// ═════════════════════════════════════════════════════════════════════════

/**
 * A time-bounded relation between two entities. The model can ask
 * "what was true on date X" by querying with a `validAt` timestamp.
 */
export interface TemporalEdge {
  /** Stable id. */
  id: string;
  /** Source entity id. */
  fromId: string;
  /** Target entity id. */
  toId: string;
  /** Relation label. Recommended: snake_case verb phrase. */
  relation: string;
  /** Inclusive lower bound, ms epoch. */
  validFrom: number;
  /** Exclusive upper bound, ms epoch. Unset means "still true". */
  validTo?: number;
  /** Free-form metadata. */
  metadata?: Record<string, unknown>;
}

export interface TemporalEdgeQuery {
  fromId?: string;
  toId?: string;
  relation?: string;
  /** Edges valid at this instant (validFrom <= t < validTo). */
  validAt?: number;
  /** Edges that overlap this window. */
  overlapsFrom?: number;
  overlapsTo?: number;
  limit?: number;
}

export interface TemporalGraph {
  add(edge: Omit<TemporalEdge, 'validFrom'> & { validFrom?: number }): Promise<TemporalEdge>;
  /** Close an open edge — sets `validTo` if not already set. */
  close(id: string, validTo?: number): Promise<TemporalEdge>;
  query(q?: TemporalEdgeQuery): Promise<TemporalEdge[]>;
}

export class InMemoryTemporalGraph implements TemporalGraph {
  private edges = new Map<string, TemporalEdge>();

  async add(edge: Omit<TemporalEdge, 'validFrom'> & { validFrom?: number }): Promise<TemporalEdge> {
    const validFrom = edge.validFrom ?? Date.now();
    const e: TemporalEdge = { ...edge, validFrom };
    this.edges.set(e.id, e);
    return { ...e };
  }

  async close(id: string, validTo: number = Date.now()): Promise<TemporalEdge> {
    const existing = this.edges.get(id);
    if (!existing) throw new Error(`Edge '${id}' not found`);
    if (existing.validTo !== undefined) return { ...existing };
    const next: TemporalEdge = { ...existing, validTo };
    this.edges.set(id, next);
    return { ...next };
  }

  async query(q: TemporalEdgeQuery = {}): Promise<TemporalEdge[]> {
    const limit = q.limit ?? 100;
    return Array.from(this.edges.values())
      .filter((e) => {
        if (q.fromId !== undefined && e.fromId !== q.fromId) return false;
        if (q.toId !== undefined && e.toId !== q.toId) return false;
        if (q.relation !== undefined && e.relation !== q.relation) return false;
        if (q.validAt !== undefined) {
          if (e.validFrom > q.validAt) return false;
          if (e.validTo !== undefined && e.validTo <= q.validAt) return false;
        }
        if (q.overlapsFrom !== undefined && e.validTo !== undefined && e.validTo <= q.overlapsFrom) return false;
        if (q.overlapsTo !== undefined && e.validFrom >= q.overlapsTo) return false;
        return true;
      })
      .sort((a, b) => b.validFrom - a.validFrom)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Composed facade
// ═════════════════════════════════════════════════════════════════════════

/**
 * Bundle the three long-horizon stores so callers can wire them as one
 * unit. Hosts can replace any single store with a remote-backed
 * implementation (Letta, Zep, Postgres) while keeping the others.
 */
export interface LongHorizonMemory {
  episodes: EpisodicMemoryStore;
  entities: EntityRegistry;
  temporal: TemporalGraph;
}

/** Create an in-memory `LongHorizonMemory` bundle. */
export function createInMemoryLongHorizonMemory(): LongHorizonMemory {
  return {
    episodes: new InMemoryEpisodicStore(),
    entities: new InMemoryEntityRegistry(),
    temporal: new InMemoryTemporalGraph(),
  };
}
