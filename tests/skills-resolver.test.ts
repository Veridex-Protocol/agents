import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../src/skills/SkillRegistry';
import { SkillResolver } from '../src/skills/SkillResolver';
import type { SkillContract } from '../src/skills/types';

function mk(id: string, triggers: SkillContract['frontmatter']['triggers']): SkillContract {
  return {
    id,
    frontmatter: {
      id,
      name: id,
      description: `desc-${id}`,
      kind: 'workflow',
      tags: [],
      triggers,
    },
    body: `body-${id}`,
    source: { kind: 'inline' },
  };
}

describe('SkillResolver', () => {
  it('keyword match scores below phrase match', () => {
    const r = new SkillRegistry();
    r.register(mk('kw', [{ type: 'keyword', value: 'transfer' }]));
    r.register(mk('ph', [{ type: 'phrase', value: 'transfer' }]));
    const out = new SkillResolver(r).resolve('Please transfer funds');
    expect(out[0].skill.id).toBe('ph');
    expect(out[1].skill.id).toBe('kw');
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('regex trigger matches case-insensitively by default', () => {
    const r = new SkillRegistry();
    r.register(mk('rx', [{ type: 'regex', pattern: '^buy\\s+\\d+' }]));
    const matches = new SkillResolver(r).resolve('BUY 100 shares');
    expect(matches[0]?.skill.id).toBe('rx');
  });

  it('intent classifier scores blend with weight', () => {
    const r = new SkillRegistry();
    r.register(mk('intent_skill', [{ type: 'intent', value: 'pay' }]));
    const out = new SkillResolver(r, {
      intentClassifiers: {
        pay: (s) => (s.includes('pay') ? 0.5 : 0),
      },
    }).resolve('please pay invoice');
    expect(out[0]?.skill.id).toBe('intent_skill');
    // weight 0.8 * 0.5 = 0.4
    expect(out[0].score).toBeCloseTo(0.4, 5);
  });

  it('minScore filter excludes weak matches', () => {
    const r = new SkillRegistry();
    r.register(mk('a', [{ type: 'keyword', value: 'foo' }]));
    const out = new SkillResolver(r, { minScore: 0.5 }).resolve('foo bar');
    expect(out).toHaveLength(0);
  });

  it('maxResults caps output', () => {
    const r = new SkillRegistry();
    for (let i = 0; i < 10; i++) r.register(mk(`s${i}`, [{ type: 'phrase', value: 'common' }]));
    const out = new SkillResolver(r, { maxResults: 3 }).resolve('common case');
    expect(out).toHaveLength(3);
  });

  it('custom strategy contributes to score', () => {
    const r = new SkillRegistry();
    r.register(mk('cust', [{ type: 'keyword', value: 'never_match_xyz' }]));
    const out = new SkillResolver(r, {
      minScore: 0.05,
      customStrategies: [
        (_i, s) =>
          s.id === 'cust'
            ? { score: 0.9, reasons: ['custom-boost'], matched: [] }
            : null,
      ],
    }).resolve('anything');
    expect(out[0]?.skill.id).toBe('cust');
    expect(out[0]?.reasons).toContain('custom-boost');
  });

  it('phrase matching is word-boundary aware', () => {
    const r = new SkillRegistry();
    r.register(mk('p', [{ type: 'phrase', value: 'pay' }]));
    const out = new SkillResolver(r).resolve('happy days');
    expect(out).toHaveLength(0);
  });

  it('invalid regex is ignored, not thrown', () => {
    const r = new SkillRegistry();
    r.register(mk('bad', [{ type: 'regex', pattern: '(' }]));
    expect(() => new SkillResolver(r).resolve('anything')).not.toThrow();
  });
});
