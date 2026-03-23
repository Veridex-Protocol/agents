/**
 * @packageDocumentation
 * @module CoreAdapter
 * @description
 * Adapter bridging @veridex/sdk into the agent runtime.
 * Wraps SDK operations (identity, signing, chain abstraction) as tool-compatible functions.
 * Works only when @veridex/sdk is installed as a peer dependency.
 */

export interface CoreAdapterConfig {
  /** Veridex SDK instance */
  sdk: unknown;
  /** Additional options */
  options?: Record<string, unknown>;
}

export class CoreAdapter {
  private sdk: unknown;

  constructor(config: CoreAdapterConfig) {
    this.sdk = config.sdk;
  }

  /** Check if the SDK is available. */
  isAvailable(): boolean {
    return this.sdk != null;
  }

  /** Get the underlying SDK instance (typed by consumer). */
  getSDK<T = unknown>(): T {
    if (!this.sdk) throw new Error('Veridex SDK not available');
    return this.sdk as T;
  }

  /** Get identity info from the SDK, if supported. */
  async getIdentity(): Promise<Record<string, unknown> | null> {
    if (!this.sdk || typeof this.sdk !== 'object') return null;
    const sdk = this.sdk as Record<string, unknown>;
    if ('getIdentity' in sdk && typeof sdk.getIdentity === 'function') {
      return (await sdk.getIdentity()) as Record<string, unknown>;
    }
    return null;
  }

  /** Get wallet/signer info from the SDK, if supported. */
  async getWallet(): Promise<unknown | null> {
    if (!this.sdk || typeof this.sdk !== 'object') return null;
    const sdk = this.sdk as Record<string, unknown>;
    if ('getWallet' in sdk && typeof sdk.getWallet === 'function') {
      return sdk.getWallet();
    }
    return null;
  }
}
