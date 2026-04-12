/**
 * @module recovery
 * @description
 * VA-DAR (Veridex Agent Definition & Artifact Recovery) key schedule
 * and artifact storage for agent credential recovery.
 *
 * Implements:
 * - Key derivation schedule using HKDF-SHA256
 * - ArtifactStore for encrypted recovery artifact management
 * - DeRec compatibility bridge for the Decentralized Recovery Alliance spec
 *
 * @see ADR-0045 — Phase 3: Recovery & Decentralization
 */

// ── Key Derivation ──

/** A derived key in the VA-DAR schedule. */
export interface DerivedKey {
  /** Key purpose identifier */
  purpose: string;
  /** Hex-encoded key material */
  keyHex: string;
  /** Derivation timestamp */
  derivedAt: number;
  /** Salt used for derivation (hex) */
  saltHex: string;
}

/** Key schedule configuration */
export interface KeyScheduleConfig {
  /** Master secret (provided by the user/agent at recovery setup). Not stored. */
  masterSecret: Uint8Array;
  /** Application-specific info string */
  info?: string;
}

/**
 * HKDF-SHA256 key derivation.
 * Uses Web Crypto for the extract-then-expand pattern.
 */
export async function hkdfDerive(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    ikm.buffer as ArrayBuffer,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt.buffer as ArrayBuffer, info: info.buffer as ArrayBuffer },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Convert bytes to hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Convert hex string to bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * VA-DAR Key Schedule — derives purpose-specific keys from a master secret.
 *
 * Key purposes:
 * - `encryption`: AES-GCM key for encrypting recovery artifacts
 * - `signing`: HMAC key for signing artifact bundles
 * - `share`: Key for Shamir secret sharing splits
 */
export class VADARKeySchedule {
  private readonly masterSecret: Uint8Array;
  private readonly infoPrefix: string;

  constructor(config: KeyScheduleConfig) {
    this.masterSecret = config.masterSecret;
    this.infoPrefix = config.info ?? 'veridex-vadar-v1';
  }

  /** Derive a key for a specific purpose. */
  async deriveKey(purpose: string, salt?: Uint8Array): Promise<DerivedKey> {
    const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(32));
    const info = new TextEncoder().encode(`${this.infoPrefix}:${purpose}`);
    const keyBytes = await hkdfDerive(this.masterSecret, actualSalt, info, 32);

    return {
      purpose,
      keyHex: bytesToHex(keyBytes),
      derivedAt: Date.now(),
      saltHex: bytesToHex(actualSalt),
    };
  }

  /** Derive the standard set of recovery keys. */
  async deriveAll(): Promise<{
    encryption: DerivedKey;
    signing: DerivedKey;
    share: DerivedKey;
  }> {
    const [encryption, signing, share] = await Promise.all([
      this.deriveKey('encryption'),
      this.deriveKey('signing'),
      this.deriveKey('share'),
    ]);
    return { encryption, signing, share };
  }
}

// ── Artifact Store ──

/** A recovery artifact — encrypted blob with metadata. */
export interface RecoveryArtifact {
  /** Unique artifact identifier */
  id: string;
  /** Artifact type */
  type: 'agent_definition' | 'credential_bundle' | 'key_share' | 'mandate_snapshot';
  /** Agent ID this artifact belongs to */
  agentId: string;
  /** Encrypted payload (base64) */
  encryptedPayload: string;
  /** IV used for encryption (hex) */
  ivHex: string;
  /** HMAC of the encrypted payload (hex) for integrity */
  hmacHex: string;
  /** Creation timestamp */
  createdAt: number;
  /** Expiration timestamp (optional) */
  expiresAt?: number;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/** Artifact store interface. */
export interface ArtifactStoreBackend {
  put(artifact: RecoveryArtifact): Promise<void>;
  get(id: string): Promise<RecoveryArtifact | null>;
  list(agentId: string): Promise<RecoveryArtifact[]>;
  delete(id: string): Promise<boolean>;
}

/**
 * In-memory artifact store (for testing / local dev).
 * Production should use encrypted persistent storage.
 */
export class InMemoryArtifactStore implements ArtifactStoreBackend {
  private readonly store = new Map<string, RecoveryArtifact>();

  async put(artifact: RecoveryArtifact): Promise<void> {
    this.store.set(artifact.id, { ...artifact });
  }

  async get(id: string): Promise<RecoveryArtifact | null> {
    return this.store.get(id) ?? null;
  }

  async list(agentId: string): Promise<RecoveryArtifact[]> {
    return [...this.store.values()].filter((a) => a.agentId === agentId);
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  /** Get total artifact count. */
  get size(): number {
    return this.store.size;
  }
}

// ── Encryption Helpers ──

/**
 * Encrypt a plaintext payload with AES-256-GCM.
 * Returns base64 ciphertext and hex IV.
 */
export async function encryptArtifact(
  plaintext: string,
  keyHex: string,
): Promise<{ ciphertextBase64: string; ivHex: string }> {
  const keyBytes = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded.buffer as ArrayBuffer,
  );
  // Convert to base64
  const bytes = new Uint8Array(ciphertext);
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return {
    ciphertextBase64: btoa(binary),
    ivHex: bytesToHex(iv),
  };
}

/**
 * Decrypt a ciphertext payload with AES-256-GCM.
 */
export async function decryptArtifact(
  ciphertextBase64: string,
  keyHex: string,
  ivHex: string,
): Promise<string> {
  const keyBytes = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    'AES-GCM',
    false,
    ['decrypt'],
  );
  // Decode base64
  const binary = atob(ciphertextBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const ivBytes = hexToBytes(ivHex);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes.buffer as ArrayBuffer },
    key,
    bytes.buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Compute HMAC-SHA256 of data.
 */
export async function hmacSHA256(data: string, keyHex: string): Promise<string> {
  const hmacKeyBytes = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey(
    'raw',
    hmacKeyBytes.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const encoded = new TextEncoder().encode(data);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    encoded.buffer as ArrayBuffer,
  );
  return bytesToHex(new Uint8Array(sig));
}

// ── DeRec Compatibility Bridge ──

/**
 * DeRec share — compatible with the Decentralized Recovery Alliance spec.
 * DeRec splits secrets into threshold-of-N shares stored with helpers.
 */
export interface DeRecShare {
  /** Share index (1-based) */
  index: number;
  /** Total shares in the set */
  totalShares: number;
  /** Threshold needed to reconstruct */
  threshold: number;
  /** Share data (hex-encoded) */
  shareHex: string;
  /** Helper (custodian) identifier */
  helperId: string;
  /** Share creation timestamp */
  createdAt: number;
}

/** DeRec helper status. */
export interface DeRecHelper {
  /** Helper identifier (could be DID, agent ID, etc.) */
  id: string;
  /** Whether the helper is currently reachable */
  reachable: boolean;
  /** Last successful communication */
  lastSeen?: number;
  /** Share index held by this helper */
  shareIndex?: number;
}

/**
 * DeRec compatibility bridge — manages share distribution to helpers.
 * Does NOT implement full Shamir secret sharing (that's a crypto primitive).
 * This layer manages the coordination protocol.
 */
export class DeRecBridge {
  private readonly helpers = new Map<string, DeRecHelper>();
  private readonly shares = new Map<string, DeRecShare>();

  /** Register a helper (custodian) for recovery. */
  registerHelper(helper: DeRecHelper): void {
    this.helpers.set(helper.id, { ...helper });
  }

  /** Remove a helper. */
  removeHelper(helperId: string): boolean {
    this.shares.delete(helperId);
    return this.helpers.delete(helperId);
  }

  /** Get all registered helpers. */
  getHelpers(): DeRecHelper[] {
    return [...this.helpers.values()];
  }

  /** Get reachable helpers. */
  getReachableHelpers(): DeRecHelper[] {
    return [...this.helpers.values()].filter((h) => h.reachable);
  }

  /** Distribute shares to helpers. */
  distributeShares(shares: DeRecShare[]): { distributed: number; failed: string[] } {
    const failed: string[] = [];
    let distributed = 0;

    for (const share of shares) {
      const helper = this.helpers.get(share.helperId);
      if (!helper || !helper.reachable) {
        failed.push(share.helperId);
        continue;
      }
      this.shares.set(share.helperId, { ...share });
      helper.shareIndex = share.index;
      distributed++;
    }

    return { distributed, failed };
  }

  /** Collect shares from helpers (for recovery). */
  collectShares(): DeRecShare[] {
    return [...this.shares.values()];
  }

  /** Check if enough shares are available for recovery. */
  canRecover(threshold: number): boolean {
    const available = [...this.shares.values()].filter((s) => {
      const helper = this.helpers.get(s.helperId);
      return helper?.reachable;
    });
    return available.length >= threshold;
  }

  /** Get current share distribution status. */
  getStatus(): {
    totalHelpers: number;
    reachableHelpers: number;
    distributedShares: number;
    canRecover: boolean;
    threshold: number;
  } {
    const allShares = [...this.shares.values()];
    const threshold = allShares[0]?.threshold ?? 0;
    return {
      totalHelpers: this.helpers.size,
      reachableHelpers: this.getReachableHelpers().length,
      distributedShares: this.shares.size,
      canRecover: this.canRecover(threshold),
      threshold,
    };
  }
}
