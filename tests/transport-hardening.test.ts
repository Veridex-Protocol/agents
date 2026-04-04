import { describe, it, expect, beforeEach } from 'vitest';
import {
  RetryExecutor,
  CircuitBreaker,
  TransportPolicyEvaluator,
  RemoteCallTracer,
  CapabilityManifestRegistry,
  DEFAULT_RETRY_POLICY,
  DEFAULT_TIMEOUT_POLICY,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from '../src/transports';
import type { CapabilityManifest, TransportPolicy } from '../src/transports';

// ── RetryExecutor ──

describe('RetryExecutor', () => {
  it('succeeds on first attempt', async () => {
    const executor = new RetryExecutor({ retry: { maxRetries: 3 } });
    const result = await executor.execute(async () => 'ok');
    expect(result.success).toBe(true);
    expect(result.value).toBe('ok');
    expect(result.attempts).toBe(1);
  });

  it('retries on transient failures', async () => {
    let calls = 0;
    const executor = new RetryExecutor({
      retry: { maxRetries: 2, backoffMs: 10, backoffMultiplier: 1, maxBackoffMs: 100, jitter: false },
    });
    const result = await executor.execute(async () => {
      calls++;
      if (calls < 3) throw new Error('fetch failed');
      return 'recovered';
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe('recovered');
    expect(result.attempts).toBe(3);
  });

  it('fails after max retries', async () => {
    const executor = new RetryExecutor({
      retry: { maxRetries: 1, backoffMs: 5, backoffMultiplier: 1, maxBackoffMs: 50, jitter: false },
    });
    const result = await executor.execute(async () => {
      throw new Error('fetch failed');
    });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.lastError).toContain('fetch failed');
  });

  it('does not retry non-retryable errors by default', async () => {
    const executor = new RetryExecutor({
      retry: { maxRetries: 3, backoffMs: 5, backoffMultiplier: 1, maxBackoffMs: 50, jitter: false },
    });
    const result = await executor.execute(async () => {
      throw new Error('Validation error');
    });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it('respects custom retryable check', async () => {
    let calls = 0;
    const executor = new RetryExecutor({
      retry: { maxRetries: 2, backoffMs: 5, backoffMultiplier: 1, maxBackoffMs: 50, jitter: false },
    });
    const result = await executor.execute(
      async () => {
        calls++;
        if (calls < 3) throw new Error('temporary');
        return 'ok';
      },
      (err) => err instanceof Error && err.message === 'temporary',
    );
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('respects deadline policy', async () => {
    const executor = new RetryExecutor({
      retry: { maxRetries: 10, backoffMs: 5, backoffMultiplier: 1, maxBackoffMs: 50, jitter: false },
      timeout: { requestTimeoutMs: 30_000, deadlineMs: Date.now() - 1 },
    });
    const result = await executor.execute(async () => 'should not run');
    expect(result.success).toBe(false);
    expect(result.lastError).toContain('Deadline exceeded');
  });

  it('applies jitter when enabled', async () => {
    const executor = new RetryExecutor({
      retry: { maxRetries: 1, backoffMs: 100, backoffMultiplier: 1, maxBackoffMs: 1000, jitter: true },
    });
    let calls = 0;
    const start = Date.now();
    await executor.execute(async () => {
      calls++;
      if (calls < 2) throw new Error('fetch failed');
      return 'ok';
    });
    const elapsed = Date.now() - start;
    // With jitter, delay should be between 50ms and 100ms (0.5*base to 1.0*base)
    expect(elapsed).toBeGreaterThanOrEqual(40); // accounting for timing imprecision
  });

  it('exports sensible defaults', () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_POLICY.jitter).toBe(true);
    expect(DEFAULT_TIMEOUT_POLICY.requestTimeoutMs).toBe(30_000);
  });
});

// ── CircuitBreaker ──

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100, halfOpenMaxProbes: 1 });
  });

  it('starts closed and allows execution', () => {
    expect(cb.getState('https://api.test')).toBe('closed');
    expect(cb.canExecute('https://api.test')).toBe(true);
  });

  it('opens after failure threshold', () => {
    const ep = 'https://api.test';
    cb.recordFailure(ep);
    cb.recordFailure(ep);
    expect(cb.getState(ep)).toBe('closed');
    cb.recordFailure(ep);
    expect(cb.getState(ep)).toBe('open');
    expect(cb.canExecute(ep)).toBe(false);
  });

  it('resets to closed on success', () => {
    const ep = 'https://api.test';
    cb.recordFailure(ep);
    cb.recordFailure(ep);
    cb.recordSuccess(ep);
    expect(cb.getState(ep)).toBe('closed');
    // Should take full threshold again to open
    cb.recordFailure(ep);
    cb.recordFailure(ep);
    expect(cb.getState(ep)).toBe('closed');
  });

  it('transitions to half-open after reset timeout', async () => {
    const ep = 'https://api.test';
    cb.recordFailure(ep);
    cb.recordFailure(ep);
    cb.recordFailure(ep); // opens
    expect(cb.canExecute(ep)).toBe(false);

    // Wait for reset timeout
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(cb.canExecute(ep)).toBe(true); // now half-open
    expect(cb.getState(ep)).toBe('half-open');
  });

  it('re-opens on half-open failure', async () => {
    const ep = 'https://api.test';
    cb.recordFailure(ep);
    cb.recordFailure(ep);
    cb.recordFailure(ep);
    await new Promise((resolve) => setTimeout(resolve, 120));
    cb.canExecute(ep); // triggers half-open transition
    cb.recordFailure(ep);
    expect(cb.getState(ep)).toBe('open');
  });

  it('closes on half-open success', async () => {
    const ep = 'https://api.test';
    cb.recordFailure(ep);
    cb.recordFailure(ep);
    cb.recordFailure(ep);
    await new Promise((resolve) => setTimeout(resolve, 120));
    cb.canExecute(ep); // half-open
    cb.recordSuccess(ep);
    expect(cb.getState(ep)).toBe('closed');
  });

  it('limits half-open probes', async () => {
    const ep = 'https://api.test';
    cb.recordFailure(ep);
    cb.recordFailure(ep);
    cb.recordFailure(ep);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(cb.canExecute(ep)).toBe(true); // first probe allowed
    cb.recordProbe(ep);
    expect(cb.canExecute(ep)).toBe(false); // second probe blocked
  });

  it('isolates endpoints independently', () => {
    cb.recordFailure('https://a.test');
    cb.recordFailure('https://a.test');
    cb.recordFailure('https://a.test');
    expect(cb.getState('https://a.test')).toBe('open');
    expect(cb.getState('https://b.test')).toBe('closed');
    expect(cb.canExecute('https://b.test')).toBe(true);
  });

  it('provides snapshot of all endpoints', () => {
    cb.recordFailure('https://a.test');
    cb.recordFailure('https://b.test');
    const snap = cb.snapshot();
    expect(snap.length).toBe(2);
    expect(snap.map((s) => s.endpoint).sort()).toEqual(['https://a.test', 'https://b.test']);
  });

  it('resets individual and all endpoints', () => {
    cb.recordFailure('https://a.test');
    cb.recordFailure('https://b.test');
    cb.reset('https://a.test');
    expect(cb.snapshot().length).toBe(1);
    cb.resetAll();
    expect(cb.snapshot().length).toBe(0);
  });

  it('exports default config', () => {
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold).toBe(5);
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs).toBe(30_000);
  });
});

// ── TransportPolicyEvaluator ──

describe('TransportPolicyEvaluator', () => {
  it('allows all when no policy is set', () => {
    const evaluator = new TransportPolicyEvaluator();
    const result = evaluator.evaluate('https://api.test/call');
    expect(result.allowed).toBe(true);
  });

  it('blocks endpoints on blocklist', () => {
    const evaluator = new TransportPolicyEvaluator({
      defaultPolicy: {
        endpoints: {
          allowedEndpoints: [],
          blockedEndpoints: ['https://malicious.test/*'],
        },
      },
    });
    const result = evaluator.evaluate('https://malicious.test/exploit');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked');
  });

  it('blocks endpoints not in allowlist', () => {
    const evaluator = new TransportPolicyEvaluator({
      defaultPolicy: {
        endpoints: {
          allowedEndpoints: ['https://trusted.test/*'],
          blockedEndpoints: [],
        },
      },
    });
    const blocked = evaluator.evaluate('https://untrusted.test/call');
    expect(blocked.allowed).toBe(false);

    const allowed = evaluator.evaluate('https://trusted.test/call');
    expect(allowed.allowed).toBe(true);
  });

  it('blocklist takes precedence over allowlist', () => {
    const evaluator = new TransportPolicyEvaluator({
      defaultPolicy: {
        endpoints: {
          allowedEndpoints: ['https://api.test/*'],
          blockedEndpoints: ['https://api.test/admin*'],
        },
      },
    });
    expect(evaluator.evaluate('https://api.test/data').allowed).toBe(true);
    expect(evaluator.evaluate('https://api.test/admin/users').allowed).toBe(false);
  });

  it('returns effective timeout and retry from default policy', () => {
    const evaluator = new TransportPolicyEvaluator({
      defaultPolicy: {
        timeout: { requestTimeoutMs: 5000 },
        retry: { ...DEFAULT_RETRY_POLICY, maxRetries: 5 },
      },
    });
    const result = evaluator.evaluate('https://api.test');
    expect(result.allowed).toBe(true);
    expect(result.effectiveTimeout?.requestTimeoutMs).toBe(5000);
    expect(result.effectiveRetry?.maxRetries).toBe(5);
  });

  it('manifest transportPolicy overrides defaults', () => {
    const evaluator = new TransportPolicyEvaluator({
      defaultPolicy: {
        timeout: { requestTimeoutMs: 5000 },
        retry: { ...DEFAULT_RETRY_POLICY, maxRetries: 2 },
      },
    });
    const manifest: CapabilityManifest = {
      name: 'expensive-op',
      version: '1.0.0',
      description: 'Slow capability',
      protocol: 'acp',
      transportPolicy: {
        timeout: { requestTimeoutMs: 60_000 },
      },
    };
    const result = evaluator.evaluate('https://api.test', manifest);
    expect(result.effectiveTimeout?.requestTimeoutMs).toBe(60_000);
    expect(result.effectiveRetry?.maxRetries).toBe(2); // kept from default
  });

  it('resolves auth from policy', () => {
    const evaluator = new TransportPolicyEvaluator({
      defaultPolicy: {
        auth: { type: 'bearer', token: 'global-token' },
      },
    });
    const result = evaluator.evaluate('https://api.test');
    expect(result.effectiveAuth?.type).toBe('bearer');
    expect(result.effectiveAuth?.token).toBe('global-token');
  });

  it('falls back to manifest auth requirements', () => {
    const evaluator = new TransportPolicyEvaluator();
    const manifest: CapabilityManifest = {
      name: 'authed-cap',
      version: '1.0.0',
      description: 'Needs API key',
      protocol: 'acp',
      authRequirements: { type: 'api-key' },
    };
    const result = evaluator.evaluate('https://api.test', manifest);
    expect(result.effectiveAuth?.type).toBe('api-key');
  });
});

// ── RemoteCallTracer ──

describe('RemoteCallTracer', () => {
  let tracer: RemoteCallTracer;

  beforeEach(() => {
    tracer = new RemoteCallTracer();
  });

  it('starts and finishes a call', () => {
    const callId = tracer.startCall({
      capability: 'search',
      protocol: 'acp',
      endpoint: 'https://api.test/search',
      callerAgentId: 'agent-1',
      callerRunId: 'run-1',
    });
    expect(callId).toMatch(/^rc_/);
    expect(tracer.size).toBe(1);

    const record = tracer.finishCall({
      callId,
      outcome: 'success',
      attempts: 1,
      costUSD: 0.01,
    });
    expect(record).toBeDefined();
    expect(record!.outcome).toBe('success');
    expect(record!.costUSD).toBe(0.01);
    expect(record!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns undefined for unknown call on finish', () => {
    expect(tracer.finishCall({ callId: 'unknown', outcome: 'failure', attempts: 1 })).toBeUndefined();
  });

  it('retrieves call by ID', () => {
    const callId = tracer.startCall({
      capability: 'translate',
      protocol: 'a2a',
      endpoint: 'https://agent.test',
      callerAgentId: 'agent-2',
      callerRunId: 'run-2',
      authMethod: 'bearer',
    });
    const record = tracer.getCall(callId);
    expect(record?.capability).toBe('translate');
    expect(record?.authMethod).toBe('bearer');
  });

  it('filters by capability', () => {
    tracer.startCall({ capability: 'search', protocol: 'acp', endpoint: 'e1', callerAgentId: 'a1', callerRunId: 'r1' });
    tracer.startCall({ capability: 'translate', protocol: 'a2a', endpoint: 'e2', callerAgentId: 'a1', callerRunId: 'r1' });
    tracer.startCall({ capability: 'search', protocol: 'acp', endpoint: 'e3', callerAgentId: 'a2', callerRunId: 'r2' });

    expect(tracer.getByCapability('search').length).toBe(2);
    expect(tracer.getByCapability('translate').length).toBe(1);
  });

  it('filters by agent', () => {
    tracer.startCall({ capability: 'c1', protocol: 'acp', endpoint: 'e1', callerAgentId: 'agent-A', callerRunId: 'r1' });
    tracer.startCall({ capability: 'c2', protocol: 'a2a', endpoint: 'e2', callerAgentId: 'agent-B', callerRunId: 'r2' });
    expect(tracer.getByAgent('agent-A').length).toBe(1);
  });

  it('computes summary statistics', () => {
    const id1 = tracer.startCall({ capability: 'c1', protocol: 'acp', endpoint: 'e1', callerAgentId: 'a1', callerRunId: 'r1' });
    const id2 = tracer.startCall({ capability: 'c2', protocol: 'a2a', endpoint: 'e2', callerAgentId: 'a1', callerRunId: 'r1' });
    tracer.finishCall({ callId: id1, outcome: 'success', attempts: 1, costUSD: 0.05 });
    tracer.finishCall({ callId: id2, outcome: 'failure', attempts: 2, error: 'timeout' });

    const summary = tracer.summary();
    expect(summary.total).toBe(2);
    expect(summary.byOutcome['success']).toBe(1);
    expect(summary.byOutcome['failure']).toBe(1);
    expect(summary.byProtocol['acp']).toBe(1);
    expect(summary.byProtocol['a2a']).toBe(1);
    expect(summary.totalCostUSD).toBe(0.05);
  });

  it('evicts oldest records when maxRecords exceeded', () => {
    const bounded = new RemoteCallTracer({ maxRecords: 2 });
    bounded.startCall({ capability: 'c1', protocol: 'acp', endpoint: 'e1', callerAgentId: 'a1', callerRunId: 'r1' });
    bounded.startCall({ capability: 'c2', protocol: 'acp', endpoint: 'e2', callerAgentId: 'a1', callerRunId: 'r1' });
    bounded.startCall({ capability: 'c3', protocol: 'acp', endpoint: 'e3', callerAgentId: 'a1', callerRunId: 'r1' });
    expect(bounded.size).toBe(2);
    expect(bounded.getByCapability('c1').length).toBe(0); // evicted
    expect(bounded.getByCapability('c3').length).toBe(1);
  });

  it('clears all records', () => {
    tracer.startCall({ capability: 'c1', protocol: 'acp', endpoint: 'e1', callerAgentId: 'a1', callerRunId: 'r1' });
    tracer.clear();
    expect(tracer.size).toBe(0);
    expect(tracer.getAll().length).toBe(0);
  });
});

// ── CapabilityManifestRegistry ──

describe('CapabilityManifestRegistry', () => {
  let registry: CapabilityManifestRegistry;

  const makeManifest = (
    name: string,
    version: string,
    protocol: CapabilityManifest['protocol'] = 'acp',
    overrides?: Partial<CapabilityManifest>,
  ): CapabilityManifest => ({
    name,
    version,
    description: `${name} v${version}`,
    protocol,
    ...overrides,
  });

  beforeEach(() => {
    registry = new CapabilityManifestRegistry();
  });

  it('registers and retrieves a manifest', () => {
    registry.register(makeManifest('search', '1.0.0'));
    expect(registry.has('search')).toBe(true);
    expect(registry.get('search')?.version).toBe('1.0.0');
  });

  it('throws on duplicate name+version', () => {
    registry.register(makeManifest('search', '1.0.0'));
    expect(() => registry.register(makeManifest('search', '1.0.0'))).toThrow('already registered');
  });

  it('allows multiple versions of same capability', () => {
    registry.register(makeManifest('search', '1.0.0'));
    registry.register(makeManifest('search', '2.0.0'));
    expect(registry.getVersions('search').length).toBe(2);
  });

  it('returns latest version by default', () => {
    registry.register(makeManifest('search', '1.0.0'));
    registry.register(makeManifest('search', '2.0.0'));
    registry.register(makeManifest('search', '1.5.0'));
    expect(registry.get('search')?.version).toBe('2.0.0');
  });

  it('returns specific version when requested', () => {
    registry.register(makeManifest('search', '1.0.0'));
    registry.register(makeManifest('search', '2.0.0'));
    expect(registry.get('search', '1.0.0')?.version).toBe('1.0.0');
  });

  it('returns undefined for missing manifest', () => {
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.has('missing')).toBe(false);
  });

  it('filters by protocol', () => {
    registry.register(makeManifest('search', '1.0.0', 'acp'));
    registry.register(makeManifest('translate', '1.0.0', 'a2a'));
    registry.register(makeManifest('tools', '1.0.0', 'mcp'));
    expect(registry.getByProtocol('acp').length).toBe(1);
    expect(registry.getByProtocol('a2a').length).toBe(1);
    expect(registry.getByProtocol('mcp').length).toBe(1);
    expect(registry.getByProtocol('local').length).toBe(0);
  });

  it('filters by tags', () => {
    registry.register(makeManifest('search', '1.0.0', 'acp', { tags: ['data', 'query'] }));
    registry.register(makeManifest('translate', '1.0.0', 'a2a', { tags: ['nlp', 'language'] }));
    registry.register(makeManifest('compute', '1.0.0', 'local', { tags: ['data', 'math'] }));

    expect(registry.getByTags(['data']).length).toBe(2);
    expect(registry.getByTags(['nlp']).length).toBe(1);
    expect(registry.getByTags(['missing']).length).toBe(0);
  });

  it('lists all capability names', () => {
    registry.register(makeManifest('b-cap', '1.0.0'));
    registry.register(makeManifest('a-cap', '1.0.0'));
    expect(registry.list()).toEqual(['a-cap', 'b-cap']);
  });

  it('removes specific version', () => {
    registry.register(makeManifest('search', '1.0.0'));
    registry.register(makeManifest('search', '2.0.0'));
    expect(registry.remove('search', '1.0.0')).toBe(true);
    expect(registry.getVersions('search').length).toBe(1);
  });

  it('removes all versions', () => {
    registry.register(makeManifest('search', '1.0.0'));
    registry.register(makeManifest('search', '2.0.0'));
    expect(registry.remove('search')).toBe(true);
    expect(registry.has('search')).toBe(false);
  });

  it('reports size correctly', () => {
    expect(registry.size).toBe(0);
    registry.register(makeManifest('a', '1.0.0'));
    registry.register(makeManifest('b', '1.0.0'));
    expect(registry.size).toBe(2);
  });

  it('provides summary', () => {
    registry.register(makeManifest('search', '1.0.0', 'acp'));
    registry.register(makeManifest('tools', '1.0.0', 'mcp'));
    const summary = registry.summary();
    expect(summary.total).toBe(2);
    expect(summary.byProtocol['acp']).toBe(1);
    expect(summary.byProtocol['mcp']).toBe(1);
    expect(summary.names).toEqual(['search', 'tools']);
  });

  it('clears all manifests', () => {
    registry.register(makeManifest('a', '1.0.0'));
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.getAll().length).toBe(0);
  });

  it('stores manifest with full metadata', () => {
    const manifest = makeManifest('rich', '1.0.0', 'acp', {
      endpoint: 'https://api.test/rich',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      authRequirements: { type: 'bearer', scopes: ['read'] },
      costEstimate: { minUSD: 0.01, maxUSD: 0.1 },
      transportPolicy: {
        timeout: { requestTimeoutMs: 60_000 },
      },
      tags: ['premium'],
      metadata: { internal: true },
    });
    registry.register(manifest);
    const retrieved = registry.get('rich');
    expect(retrieved?.endpoint).toBe('https://api.test/rich');
    expect(retrieved?.authRequirements?.scopes).toEqual(['read']);
    expect(retrieved?.costEstimate?.minUSD).toBe(0.01);
    expect(retrieved?.transportPolicy?.timeout?.requestTimeoutMs).toBe(60_000);
    expect(retrieved?.tags).toEqual(['premium']);
  });
});
