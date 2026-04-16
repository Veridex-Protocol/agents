/**
 * @packageDocumentation
 * @module ResponseSeal
 * @description
 * HMAC chain-of-custody seal for LLM provider responses.
 *
 * Derives a purpose-specific HMAC key from the provider API key using HKDF,
 * then HMAC-SHA256 signs the canonical response content at the adapter boundary.
 *
 * **What this proves**: the response payload has not been modified after it left
 * the provider adapter — no intermediate hook, plugin, or middleware has tampered
 * with it between the HTTP boundary and downstream consumption.
 *
 * **What this does NOT prove**: that the provider itself generated the payload.
 * True provider origin authentication requires asymmetric signatures from the
 * provider's private key (none currently offer this).
 *
 * Uses Web Crypto API for cross-runtime compatibility (Node 18+, Bun, Deno, browsers).
 */

import { canonicalJSON } from './integrity';

// ── Types ──

/** Data attached to a sealed ModelResponse. */
export interface ResponseSealData {
  /** HMAC-SHA256 hex digest of the canonical response content */
  hmac: string;
  /** Timestamp (ms) when the seal was created */
  sealedAt: number;
  /** Provider name that produced the seal */
  provider: string;
  /** HKDF info string used for key derivation (for verification) */
  keyInfo: string;
}

/** Canonical response fields included in the HMAC input. */
export interface SealableResponse {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  model: string;
  provider: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  finishReason: string;
}

// ── Constants ──

const HKDF_SALT = 'veridex-response-seal-v1';
const HKDF_HASH = 'SHA-256';
const HMAC_HASH = 'SHA-256';
const DERIVED_KEY_LENGTH_BITS = 256;

// ── Key Derivation ──

/**
 * Derive a purpose-specific HMAC key from an API key using HKDF.
 *
 * The info parameter binds the derived key to a specific purpose,
 * preventing key reuse across different HMAC domains.
 */
async function deriveHmacKey(
  apiKey: string,
  info: string,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();

  // Import the API key as raw key material for HKDF
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(apiKey),
    'HKDF',
    false,
    ['deriveKey'],
  );

  // Derive an HMAC key using HKDF
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: HKDF_HASH,
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(info),
    },
    keyMaterial,
    { name: 'HMAC', hash: HMAC_HASH, length: DERIVED_KEY_LENGTH_BITS },
    false, // not extractable
    ['sign', 'verify'],
  );
}

// ── Seal Creation ──

/**
 * Build the canonical HMAC input for a response.
 * Deterministic: same response always produces the same input bytes.
 */
function buildHmacInput(response: SealableResponse, sealedAt: number): string {
  return canonicalJSON({
    content: response.content,
    toolCalls: response.toolCalls ?? null,
    model: response.model,
    provider: response.provider,
    usage: response.usage,
    finishReason: response.finishReason,
    sealedAt,
  });
}

/**
 * Create an HMAC chain-of-custody seal for a provider response.
 *
 * Call this at the very end of each provider's `complete()` method,
 * immediately before returning the ModelResponse.
 *
 * @param apiKey  The provider API key (the shared secret).
 * @param response  The response fields to seal.
 * @param provider  Provider name (used as part of HKDF info).
 * @returns The seal data to attach to the response, or null if no API key.
 */
export async function createResponseSeal(
  apiKey: string | undefined,
  response: SealableResponse,
  provider: string,
): Promise<ResponseSealData | null> {
  if (!apiKey) return null;

  const keyInfo = `${provider}:response-seal`;
  const sealedAt = Date.now();
  const input = buildHmacInput(response, sealedAt);

  const hmacKey = await deriveHmacKey(apiKey, keyInfo);
  const signature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(input),
  );

  const hmac = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return { hmac, sealedAt, provider, keyInfo };
}

// ── Seal Verification ──

/**
 * Verify an HMAC chain-of-custody seal against a response.
 *
 * @param apiKey  The provider API key used when the seal was created.
 * @param response  The response fields to verify.
 * @param seal  The seal data attached to the response.
 * @returns True if the seal is valid, false if tampered or invalid.
 */
export async function verifyResponseSeal(
  apiKey: string,
  response: SealableResponse,
  seal: ResponseSealData,
): Promise<boolean> {
  const input = buildHmacInput(response, seal.sealedAt);

  const hmacKey = await deriveHmacKey(apiKey, seal.keyInfo);
  const expectedSignature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(input),
  );

  const expectedHmac = Array.from(new Uint8Array(expectedSignature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  if (expectedHmac.length !== seal.hmac.length) return false;
  let result = 0;
  for (let i = 0; i < expectedHmac.length; i++) {
    result |= expectedHmac.charCodeAt(i) ^ seal.hmac.charCodeAt(i);
  }
  return result === 0;
}
