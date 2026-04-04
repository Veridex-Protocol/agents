/**
 * @packageDocumentation
 * @module AccountabilityStores
 * @description
 * Local in-memory and file-backed stores for durable run/thread state
 * and replayable execution graphs.
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ExecutionEdge,
  ExecutionGraph,
  ExecutionGraphRef,
  ExecutionGraphStore,
  ExecutionNode,
  IdempotencyKey,
  RunStore,
  SideEffectReceipt,
  StoredRunRecord,
  ThreadRecord,
  ThreadStore,
} from '../types/accountability';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortByUpdatedAtDescending<T extends { updatedAt: number }>(records: T[]): T[] {
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt);
}

export class InMemoryRunStore implements RunStore {
  private readonly records = new Map<string, StoredRunRecord>();

  async read(runId: string): Promise<StoredRunRecord | null> {
    return clone(this.records.get(runId) ?? null);
  }

  async write(record: StoredRunRecord): Promise<StoredRunRecord> {
    this.records.set(record.run.id, clone(record));
    return clone(record);
  }

  async list(filter?: {
    agentId?: string;
    state?: StoredRunRecord['run']['state'];
    limit?: number;
  }): Promise<StoredRunRecord[]> {
    let records = [...this.records.values()];
    if (filter?.agentId) {
      records = records.filter((record) => record.run.agentId === filter.agentId);
    }
    if (filter?.state) {
      records = records.filter((record) => record.run.state === filter.state);
    }
    const sorted = sortByUpdatedAtDescending(records);
    return clone(filter?.limit ? sorted.slice(0, filter.limit) : sorted);
  }

  async delete(runId: string): Promise<boolean> {
    return this.records.delete(runId);
  }
}

export class InMemoryThreadStore implements ThreadStore {
  private readonly records = new Map<string, ThreadRecord>();

  async read(threadId: string): Promise<ThreadRecord | null> {
    return clone(this.records.get(threadId) ?? null);
  }

  async write(record: ThreadRecord): Promise<ThreadRecord> {
    this.records.set(record.id, clone(record));
    return clone(record);
  }

  async list(filter?: {
    agentId?: string;
    state?: ThreadRecord['state'];
    limit?: number;
  }): Promise<ThreadRecord[]> {
    let records = [...this.records.values()];
    if (filter?.agentId) {
      records = records.filter((record) => record.agentId === filter.agentId);
    }
    if (filter?.state) {
      records = records.filter((record) => record.state === filter.state);
    }
    const sorted = sortByUpdatedAtDescending(records);
    return clone(filter?.limit ? sorted.slice(0, filter.limit) : sorted);
  }

  async delete(threadId: string): Promise<boolean> {
    return this.records.delete(threadId);
  }
}

export class InMemoryExecutionGraphStore implements ExecutionGraphStore {
  private readonly graphs = new Map<string, ExecutionGraph>();

  private ensureGraph(runId: string): ExecutionGraph {
    const existing = this.graphs.get(runId);
    if (existing) {
      return existing;
    }
    const created: ExecutionGraph = {
      runId,
      nodes: [],
      edges: [],
      receipts: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.graphs.set(runId, created);
    return created;
  }

  async appendNode(node: ExecutionNode): Promise<ExecutionNode> {
    const graph = this.ensureGraph(node.runId);
    graph.nodes.push(clone(node));
    graph.updatedAt = Date.now();
    return clone(node);
  }

  async appendEdge(edge: ExecutionEdge): Promise<ExecutionEdge> {
    const graph = this.ensureGraph(edge.runId);
    graph.edges.push(clone(edge));
    graph.updatedAt = Date.now();
    return clone(edge);
  }

  async recordReceipt(receipt: SideEffectReceipt): Promise<SideEffectReceipt> {
    const graph = this.ensureGraph(receipt.runId);
    const existingIndex = graph.receipts.findIndex(
      (entry) => entry.idempotencyKey === receipt.idempotencyKey,
    );
    if (existingIndex >= 0) {
      graph.receipts.splice(existingIndex, 1, clone(receipt));
    } else {
      graph.receipts.push(clone(receipt));
    }
    graph.updatedAt = Date.now();
    return clone(receipt);
  }

  async getGraph(runId: string): Promise<ExecutionGraph | null> {
    return clone(this.graphs.get(runId) ?? null);
  }

  async getRef(runId: string): Promise<ExecutionGraphRef> {
    const graph = this.graphs.get(runId);
    return {
      runId,
      nodeCount: graph?.nodes.length ?? 0,
      edgeCount: graph?.edges.length ?? 0,
      receiptCount: graph?.receipts.length ?? 0,
      updatedAt: graph?.updatedAt,
    };
  }

  async findReceiptByIdempotencyKey(
    runId: string,
    idempotencyKey: IdempotencyKey,
  ): Promise<SideEffectReceipt | null> {
    const graph = this.graphs.get(runId);
    return clone(graph?.receipts.find((receipt) => receipt.idempotencyKey === idempotencyKey) ?? null);
  }

  async clear(runId?: string): Promise<void> {
    if (runId) {
      this.graphs.delete(runId);
      return;
    }
    this.graphs.clear();
  }
}

class FileBackedStore {
  constructor(protected readonly directory: string) {}

  protected async ensureDir(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  protected filePath(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  protected async readJson<T>(id: string): Promise<T | null> {
    try {
      const raw = await readFile(this.filePath(id), 'utf8');
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  protected async writeJson<T>(id: string, value: T): Promise<T> {
    await this.ensureDir();
    await writeFile(this.filePath(id), JSON.stringify(value, null, 2), 'utf8');
    return value;
  }

  protected async deleteJson(id: string): Promise<boolean> {
    try {
      await unlink(this.filePath(id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  protected async listJson<T>(): Promise<T[]> {
    await this.ensureDir();
    const files = await readdir(this.directory);
    const records: T[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const raw = await readFile(join(this.directory, file), 'utf8');
      records.push(JSON.parse(raw) as T);
    }
    return records;
  }
}

export class FileRunStore extends FileBackedStore implements RunStore {
  constructor(directory = '.veridex/runs') {
    super(directory);
  }

  async read(runId: string): Promise<StoredRunRecord | null> {
    return this.readJson<StoredRunRecord>(runId);
  }

  async write(record: StoredRunRecord): Promise<StoredRunRecord> {
    return this.writeJson(record.run.id, record);
  }

  async list(filter?: {
    agentId?: string;
    state?: StoredRunRecord['run']['state'];
    limit?: number;
  }): Promise<StoredRunRecord[]> {
    let records = await this.listJson<StoredRunRecord>();
    if (filter?.agentId) {
      records = records.filter((record) => record.run.agentId === filter.agentId);
    }
    if (filter?.state) {
      records = records.filter((record) => record.run.state === filter.state);
    }
    const sorted = sortByUpdatedAtDescending(records);
    return filter?.limit ? sorted.slice(0, filter.limit) : sorted;
  }

  async delete(runId: string): Promise<boolean> {
    return this.deleteJson(runId);
  }
}

export class FileThreadStore extends FileBackedStore implements ThreadStore {
  constructor(directory = '.veridex/threads') {
    super(directory);
  }

  async read(threadId: string): Promise<ThreadRecord | null> {
    return this.readJson<ThreadRecord>(threadId);
  }

  async write(record: ThreadRecord): Promise<ThreadRecord> {
    return this.writeJson(record.id, record);
  }

  async list(filter?: {
    agentId?: string;
    state?: ThreadRecord['state'];
    limit?: number;
  }): Promise<ThreadRecord[]> {
    let records = await this.listJson<ThreadRecord>();
    if (filter?.agentId) {
      records = records.filter((record) => record.agentId === filter.agentId);
    }
    if (filter?.state) {
      records = records.filter((record) => record.state === filter.state);
    }
    const sorted = sortByUpdatedAtDescending(records);
    return filter?.limit ? sorted.slice(0, filter.limit) : sorted;
  }

  async delete(threadId: string): Promise<boolean> {
    return this.deleteJson(threadId);
  }
}

export class FileExecutionGraphStore extends FileBackedStore implements ExecutionGraphStore {
  constructor(directory = '.veridex/execution-graphs') {
    super(directory);
  }

  private async ensureGraph(runId: string): Promise<ExecutionGraph> {
    const existing = await this.readJson<ExecutionGraph>(runId);
    if (existing) {
      return existing;
    }
    return {
      runId,
      nodes: [],
      edges: [],
      receipts: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  async appendNode(node: ExecutionNode): Promise<ExecutionNode> {
    const graph = await this.ensureGraph(node.runId);
    graph.nodes.push(clone(node));
    graph.updatedAt = Date.now();
    await this.writeJson(node.runId, graph);
    return clone(node);
  }

  async appendEdge(edge: ExecutionEdge): Promise<ExecutionEdge> {
    const graph = await this.ensureGraph(edge.runId);
    graph.edges.push(clone(edge));
    graph.updatedAt = Date.now();
    await this.writeJson(edge.runId, graph);
    return clone(edge);
  }

  async recordReceipt(receipt: SideEffectReceipt): Promise<SideEffectReceipt> {
    const graph = await this.ensureGraph(receipt.runId);
    const existingIndex = graph.receipts.findIndex(
      (entry) => entry.idempotencyKey === receipt.idempotencyKey,
    );
    if (existingIndex >= 0) {
      graph.receipts.splice(existingIndex, 1, clone(receipt));
    } else {
      graph.receipts.push(clone(receipt));
    }
    graph.updatedAt = Date.now();
    await this.writeJson(receipt.runId, graph);
    return clone(receipt);
  }

  async getGraph(runId: string): Promise<ExecutionGraph | null> {
    return this.readJson<ExecutionGraph>(runId);
  }

  async getRef(runId: string): Promise<ExecutionGraphRef> {
    const graph = await this.readJson<ExecutionGraph>(runId);
    return {
      runId,
      nodeCount: graph?.nodes.length ?? 0,
      edgeCount: graph?.edges.length ?? 0,
      receiptCount: graph?.receipts.length ?? 0,
      updatedAt: graph?.updatedAt,
    };
  }

  async findReceiptByIdempotencyKey(
    runId: string,
    idempotencyKey: IdempotencyKey,
  ): Promise<SideEffectReceipt | null> {
    const graph = await this.readJson<ExecutionGraph>(runId);
    return clone(graph?.receipts.find((receipt) => receipt.idempotencyKey === idempotencyKey) ?? null);
  }

  async clear(runId?: string): Promise<void> {
    if (runId) {
      await this.deleteJson(runId);
      return;
    }
    await this.ensureDir();
    const files = await readdir(this.directory);
    await Promise.all(
      files.filter((file) => file.endsWith('.json')).map((file) => unlink(join(this.directory, file))),
    );
  }
}
