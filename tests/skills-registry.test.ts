import { describe, it, expect } from 'vitest';
import { SkillRegistry, renderSkillDetail } from '../src/skills/SkillRegistry';
import type { SkillContract } from '../src/skills/types';

function mk(id: string, overrides: Partial<SkillContract['frontmatter']> = {}): SkillContract {
  return {
    id,
    frontmatter: {
      id,
      name: id,
      description: `desc-${id}`,
      kind: 'workflow',
      tags: [],
      triggers: [{ type: 'phrase', value: id }],
      ...overrides,
    },
    body: `body of ${id}`,
    source: { kind: 'inline' },
  };
}

describe('SkillRegistry', () => {
  it('register / load / size', () => {
    const r = new SkillRegistry();
    r.register(mk('a'));
    r.register(mk('b'));
    expect(r.size()).toBe(2);
    expect(r.load('a')?.body).toContain('body of a');
    expect(r.load('missing')).toBeUndefined();
  });

  it('register throws on duplicate; replace overwrites', () => {
    const r = new SkillRegistry();
    r.register(mk('a'));
    expect(() => r.register(mk('a'))).toThrow(/already registered/);
    r.replace(mk('a', { description: 'new' }));
    expect(r.load('a')?.frontmatter.description).toBe('new');
  });

  it('registerMany dedupes by id', () => {
    const r = new SkillRegistry();
    const result = r.registerMany([mk('a'), mk('b'), mk('a')]);
    expect(result.registered).toBe(2);
    expect(result.duplicates).toEqual(['a']);
  });

  it('list returns summaries sorted by id', () => {
    const r = new SkillRegistry();
    r.register(mk('z'));
    r.register(mk('a'));
    r.register(mk('m'));
    expect(r.list().map((s) => s.id)).toEqual(['a', 'm', 'z']);
  });

  it('renderDisclosedCatalog produces stable lines + load hint', () => {
    const r = new SkillRegistry();
    r.register(mk('alpha', { tags: ['t1', 't2'] }));
    const out = r.renderDisclosedCatalog();
    expect(out).toContain('- alpha [workflow] — desc-alpha');
    expect(out).toContain('tags: t1, t2');
    expect(out).toContain('load_skill(id)');
  });

  it('unregister removes', () => {
    const r = new SkillRegistry();
    r.register(mk('x'));
    expect(r.unregister('x')).toBe(true);
    expect(r.size()).toBe(0);
    expect(r.unregister('x')).toBe(false);
  });

  it('renderSkillDetail surfaces body + metadata', () => {
    const detail = renderSkillDetail(
      mk('rich', { version: '1.0', packId: 'pack-1', tags: ['k'] }),
    );
    expect(detail).toContain('Skill: rich');
    expect(detail).toContain('Kind: workflow');
    expect(detail).toContain('Version: 1.0');
    expect(detail).toContain('Pack: pack-1');
    expect(detail).toContain('body of rich');
  });
});
