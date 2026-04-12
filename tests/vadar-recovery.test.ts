/**
 * Tests for Phase 3: VA-DAR Recovery & DeRec Compatibility
 */
import { describe, it, expect } from 'vitest';
import {
  VADARKeySchedule,
  InMemoryArtifactStore,
  DeRecBridge,
  hkdfDerive,
  bytesToHex,
  hexToBytes,
  encryptArtifact,
  decryptArtifact,
  hmacSHA256,
} from '../src';

// ── Utilities ──

describe('bytesToHex / hexToBytes', () => {
  it('round-trips', () => {
    const original = new Uint8Array([0, 1, 127, 255, 16]);
    const hex = bytesToHex(original);
    const back = hexToBytes(hex);
    expect(back).toEqual(original);
  });

  it('produces correct hex', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });
});

// ── HKDF ──

describe('hkdfDerive', () => {
  it('derives deterministic keys', async () => {
    const ikm = new TextEncoder().encode('master-secret');
    const salt = new Uint8Array(32);
    const info = new TextEncoder().encode('test-purpose');
    const key1 = await hkdfDerive(ikm, salt, info, 32);
    const key2 = await hkdfDerive(ikm, salt, info, 32);
    expect(bytesToHex(key1)).toBe(bytesToHex(key2));
  });

  it('produces different keys for different info', async () => {
    const ikm = new TextEncoder().encode('master-secret');
    const salt = new Uint8Array(32);
    const key1 = await hkdfDerive(ikm, salt, new TextEncoder().encode('a'), 32);
    const key2 = await hkdfDerive(ikm, salt, new TextEncoder().encode('b'), 32);
    expect(bytesToHex(key1)).not.toBe(bytesToHex(key2));
  });

  it('produces requested length', async () => {
    const key = await hkdfDerive(
      new TextEncoder().encode('s'),
      new Uint8Array(32),
      new TextEncoder().encode('i'),
      16,
    );
    expect(key.length).toBe(16);
  });
});

// ── VADARKeySchedule ──

describe('VADARKeySchedule', () => {
  it('derives purpose-specific keys', async () => {
    const ks = new VADARKeySchedule({
      masterSecret: new TextEncoder().encode('test-master-secret'),
    });
    const key = await ks.deriveKey('encryption');
    expect(key.purpose).toBe('encryption');
    expect(key.keyHex.length).toBe(64); // 32 bytes = 64 hex chars
    expect(key.saltHex.length).toBe(64);
    expect(key.derivedAt).toBeGreaterThan(0);
  });

  it('same salt produces same key', async () => {
    const salt = new Uint8Array(32).fill(42);
    const ks = new VADARKeySchedule({
      masterSecret: new TextEncoder().encode('test'),
    });
    const k1 = await ks.deriveKey('encryption', salt);
    const k2 = await ks.deriveKey('encryption', salt);
    expect(k1.keyHex).toBe(k2.keyHex);
  });

  it('deriveAll returns 3 keys', async () => {
    const ks = new VADARKeySchedule({
      masterSecret: new TextEncoder().encode('test'),
    });
    const keys = await ks.deriveAll();
    expect(keys.encryption.purpose).toBe('encryption');
    expect(keys.signing.purpose).toBe('signing');
    expect(keys.share.purpose).toBe('share');
    // All different
    expect(keys.encryption.keyHex).not.toBe(keys.signing.keyHex);
    expect(keys.signing.keyHex).not.toBe(keys.share.keyHex);
  });
});

// ── Encryption ──

describe('encryptArtifact / decryptArtifact', () => {
  it('round-trips plaintext', async () => {
    const ks = new VADARKeySchedule({
      masterSecret: new TextEncoder().encode('test'),
    });
    const salt = new Uint8Array(32).fill(1);
    const key = await ks.deriveKey('encryption', salt);

    const { ciphertextBase64, ivHex } = await encryptArtifact(
      'hello recovery world',
      key.keyHex,
    );
    expect(ciphertextBase64).toBeTruthy();

    const plaintext = await decryptArtifact(ciphertextBase64, key.keyHex, ivHex);
    expect(plaintext).toBe('hello recovery world');
  });

  it('different IVs produce different ciphertexts', async () => {
    const ks = new VADARKeySchedule({
      masterSecret: new TextEncoder().encode('test'),
    });
    const salt = new Uint8Array(32).fill(1);
    const key = await ks.deriveKey('encryption', salt);

    const a = await encryptArtifact('data', key.keyHex);
    const b = await encryptArtifact('data', key.keyHex);
    expect(a.ciphertextBase64).not.toBe(b.ciphertextBase64);
  });
});

// ── HMAC ──

describe('hmacSHA256', () => {
  it('produces deterministic HMAC', async () => {
    const ks = new VADARKeySchedule({
      masterSecret: new TextEncoder().encode('test'),
    });
    const salt = new Uint8Array(32).fill(2);
    const key = await ks.deriveKey('signing', salt);

    const mac1 = await hmacSHA256('test data', key.keyHex);
    const mac2 = await hmacSHA256('test data', key.keyHex);
    expect(mac1).toBe(mac2);
  });

  it('different data produces different HMAC', async () => {
    const ks = new VADARKeySchedule({
      masterSecret: new TextEncoder().encode('test'),
    });
    const salt = new Uint8Array(32).fill(2);
    const key = await ks.deriveKey('signing', salt);

    const mac1 = await hmacSHA256('data a', key.keyHex);
    const mac2 = await hmacSHA256('data b', key.keyHex);
    expect(mac1).not.toBe(mac2);
  });
});

// ── InMemoryArtifactStore ──

describe('InMemoryArtifactStore', () => {
  it('stores and retrieves artifacts', async () => {
    const store = new InMemoryArtifactStore();
    await store.put({
      id: 'art-1',
      type: 'agent_definition',
      agentId: 'agent-1',
      encryptedPayload: 'abc',
      ivHex: 'def',
      hmacHex: 'ghi',
      createdAt: Date.now(),
    });
    const got = await store.get('art-1');
    expect(got).toBeDefined();
    expect(got!.agentId).toBe('agent-1');
  });

  it('lists by agent', async () => {
    const store = new InMemoryArtifactStore();
    await store.put({ id: 'a1', type: 'agent_definition', agentId: 'x', encryptedPayload: '', ivHex: '', hmacHex: '', createdAt: 0 });
    await store.put({ id: 'a2', type: 'key_share', agentId: 'x', encryptedPayload: '', ivHex: '', hmacHex: '', createdAt: 0 });
    await store.put({ id: 'a3', type: 'credential_bundle', agentId: 'y', encryptedPayload: '', ivHex: '', hmacHex: '', createdAt: 0 });
    const xArtifacts = await store.list('x');
    expect(xArtifacts).toHaveLength(2);
  });

  it('deletes artifacts', async () => {
    const store = new InMemoryArtifactStore();
    await store.put({ id: 'del', type: 'key_share', agentId: 'z', encryptedPayload: '', ivHex: '', hmacHex: '', createdAt: 0 });
    expect(await store.delete('del')).toBe(true);
    expect(await store.get('del')).toBeNull();
  });

  it('tracks size', async () => {
    const store = new InMemoryArtifactStore();
    expect(store.size).toBe(0);
    await store.put({ id: 'x', type: 'key_share', agentId: 'a', encryptedPayload: '', ivHex: '', hmacHex: '', createdAt: 0 });
    expect(store.size).toBe(1);
  });
});

// ── DeRecBridge ──

describe('DeRecBridge', () => {
  function makeHelper(id: string, reachable = true) {
    return { id, reachable, lastSeen: Date.now() };
  }

  function makeShare(index: number, helperId: string): Parameters<DeRecBridge['distributeShares']>[0][0] {
    return {
      index,
      totalShares: 3,
      threshold: 2,
      shareHex: 'deadbeef',
      helperId,
      createdAt: Date.now(),
    };
  }

  it('registers and lists helpers', () => {
    const bridge = new DeRecBridge();
    bridge.registerHelper(makeHelper('h1'));
    bridge.registerHelper(makeHelper('h2'));
    expect(bridge.getHelpers()).toHaveLength(2);
  });

  it('removes helpers', () => {
    const bridge = new DeRecBridge();
    bridge.registerHelper(makeHelper('h1'));
    expect(bridge.removeHelper('h1')).toBe(true);
    expect(bridge.getHelpers()).toHaveLength(0);
  });

  it('distributes shares to reachable helpers', () => {
    const bridge = new DeRecBridge();
    bridge.registerHelper(makeHelper('h1', true));
    bridge.registerHelper(makeHelper('h2', false));
    const result = bridge.distributeShares([
      makeShare(1, 'h1'),
      makeShare(2, 'h2'),
    ]);
    expect(result.distributed).toBe(1);
    expect(result.failed).toEqual(['h2']);
  });

  it('collects distributed shares', () => {
    const bridge = new DeRecBridge();
    bridge.registerHelper(makeHelper('h1'));
    bridge.registerHelper(makeHelper('h2'));
    bridge.distributeShares([
      makeShare(1, 'h1'),
      makeShare(2, 'h2'),
    ]);
    const collected = bridge.collectShares();
    expect(collected).toHaveLength(2);
  });

  it('checks recovery feasibility', () => {
    const bridge = new DeRecBridge();
    bridge.registerHelper(makeHelper('h1'));
    bridge.registerHelper(makeHelper('h2'));
    bridge.registerHelper(makeHelper('h3'));
    bridge.distributeShares([
      makeShare(1, 'h1'),
      makeShare(2, 'h2'),
      makeShare(3, 'h3'),
    ]);
    expect(bridge.canRecover(2)).toBe(true);
    expect(bridge.canRecover(4)).toBe(false);
  });

  it('reports status', () => {
    const bridge = new DeRecBridge();
    bridge.registerHelper(makeHelper('h1'));
    bridge.registerHelper(makeHelper('h2', false));
    bridge.distributeShares([makeShare(1, 'h1')]);
    const status = bridge.getStatus();
    expect(status.totalHelpers).toBe(2);
    expect(status.reachableHelpers).toBe(1);
    expect(status.distributedShares).toBe(1);
  });
});
