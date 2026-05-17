import { describe, it, expect } from 'vitest';
import {
  LinearFidelityModel,
  MODEL_DEGRADATION,
  degradationFor,
  registerModelDegradation,
  resolveFidelityModel,
} from '../src/context/FidelityModel';

describe('LinearFidelityModel', () => {
  it('returns 1 at P=0', () => {
    const m = new LinearFidelityModel(0.4);
    expect(m.fidelity(0)).toBe(1);
  });

  it('decreases linearly with P', () => {
    const m = new LinearFidelityModel(0.4);
    // F(50k) = 1 - 0.4 * 50k/100k = 1 - 0.2 = 0.8
    expect(m.fidelity(50_000)).toBeCloseTo(0.8, 6);
    // F(100k) = 1 - 0.4 = 0.6
    expect(m.fidelity(100_000)).toBeCloseTo(0.6, 6);
  });

  it('clamps fidelity to [0, 1]', () => {
    const m = new LinearFidelityModel(0.4);
    // F(1M) = 1 - 4 = -3 → 0
    expect(m.fidelity(1_000_000)).toBe(0);
    // Negative P is treated as 0
    expect(m.fidelity(-1)).toBe(1);
  });

  it('pGate is the inverse of fidelity', () => {
    const m = new LinearFidelityModel(0.4);
    // pGate(0.8) where F(P)=0.8 → P = (1-0.8)*100k/0.4 = 50k
    expect(m.pGate(0.8)).toBeCloseTo(50_000, 6);
    expect(m.fidelity(m.pGate(0.8))).toBeCloseTo(0.8, 6);
  });

  it('pGate handles edge targets', () => {
    const m = new LinearFidelityModel(0.4);
    expect(m.pGate(1)).toBe(0);
    expect(m.pGate(0)).toBe(Infinity);
  });

  it('zero degradation means infinite pGate', () => {
    const m = new LinearFidelityModel(0);
    expect(m.fidelity(1_000_000)).toBe(1);
    expect(m.pGate(0.5)).toBe(Infinity);
  });

  it('rejects invalid degradation', () => {
    expect(() => new LinearFidelityModel(-0.1)).toThrow();
    expect(() => new LinearFidelityModel(NaN)).toThrow();
  });

  it('monotonically non-increasing', () => {
    const m = new LinearFidelityModel(0.4);
    let prev = m.fidelity(0);
    for (let p = 1_000; p <= 300_000; p += 1_000) {
      const f = m.fidelity(p);
      expect(f).toBeLessThanOrEqual(prev);
      prev = f;
    }
  });
});

describe('degradationFor', () => {
  it('returns the default for unknown models', () => {
    expect(degradationFor()).toBe(MODEL_DEGRADATION.default);
    expect(degradationFor('totally-fake-model-xyz')).toBe(MODEL_DEGRADATION.default);
  });

  it('resolves known model exactly', () => {
    expect(degradationFor('claude-3.5-sonnet')).toBe(MODEL_DEGRADATION['claude-3.5-sonnet']);
  });

  it('uses longest-prefix match for versioned ids', () => {
    expect(degradationFor('gpt-4o-2024-11-20')).toBe(MODEL_DEGRADATION['gpt-4o']);
    expect(degradationFor('claude-3.5-sonnet-20241022')).toBe(
      MODEL_DEGRADATION['claude-3.5-sonnet'],
    );
  });

  it('honors runtime registration', () => {
    registerModelDegradation('custom-model-xyz', 0.12);
    expect(degradationFor('custom-model-xyz')).toBe(0.12);
    expect(degradationFor('custom-model-xyz-v2')).toBe(0.12);
  });

  it('rejects invalid registration', () => {
    expect(() => registerModelDegradation('bad', -1)).toThrow();
    expect(() => registerModelDegradation('bad', NaN)).toThrow();
  });
});

describe('resolveFidelityModel', () => {
  it('returns the explicit instance when provided', () => {
    const explicit = new LinearFidelityModel(0.1);
    expect(resolveFidelityModel({ model: explicit })).toBe(explicit);
  });

  it('builds from degradation when given', () => {
    const m = resolveFidelityModel({ degradation: 0.25 });
    expect(m).toBeInstanceOf(LinearFidelityModel);
    expect((m as LinearFidelityModel).degradation).toBe(0.25);
  });

  it('builds from model id lookup', () => {
    const m = resolveFidelityModel({ modelId: 'claude-3.5-sonnet' });
    expect((m as LinearFidelityModel).degradation).toBe(
      MODEL_DEGRADATION['claude-3.5-sonnet'],
    );
  });

  it('falls back to default with no input', () => {
    const m = resolveFidelityModel();
    expect((m as LinearFidelityModel).degradation).toBe(MODEL_DEGRADATION.default);
  });
});
