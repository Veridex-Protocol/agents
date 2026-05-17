import { describe, it, expect } from 'vitest';
import { skillify } from '../src/skills/skillify';
import { parseSkillDocument } from '../src/skills/parser';

describe('skillify', () => {
  it('produces 10 artifacts covering the lifecycle', () => {
    const result = skillify({
      id: 'detect_chargeback',
      description: 'Recognise chargeback intents and route to dispute flow.',
      triggers: [
        { type: 'phrase', value: 'chargeback' },
        { type: 'keyword', value: 'dispute' },
      ],
    });
    expect(result.id).toBe('detect_chargeback');
    expect(result.artifacts).toHaveLength(10);
    const paths = result.artifacts.map((a) => a.path).sort();
    expect(paths).toContain('skills/detect_chargeback/SKILL.md');
    expect(paths).toContain('skills/detect_chargeback/script.ts');
    expect(paths).toContain('skills/detect_chargeback/script.test.ts');
    expect(paths).toContain('skills/detect_chargeback/integration.test.ts');
    expect(paths).toContain('skills/detect_chargeback/eval.jsonl');
    expect(paths).toContain('skills/detect_chargeback/resolver.ts');
    expect(paths).toContain('skills/detect_chargeback/resolver.eval.test.ts');
    expect(paths).toContain('skills/detect_chargeback/DRY.md');
    expect(paths).toContain('skills/detect_chargeback/smoke.ts');
    expect(paths).toContain('skills/detect_chargeback/BRAIN.md');
  });

  it('rejects invalid ids', () => {
    expect(() =>
      skillify({
        id: 'Bad-Id',
        description: 'x',
        triggers: [{ type: 'phrase', value: 'x' }],
      }),
    ).toThrow(/snake_case/);
  });

  it('requires at least one trigger', () => {
    expect(() =>
      skillify({ id: 'a', description: 'x', triggers: [] }),
    ).toThrow(/trigger/);
  });

  it('SKILL.md round-trips through the parser', () => {
    const result = skillify({
      id: 'roundtrip',
      description: 'Round trip',
      kind: 'workflow',
      tags: ['t1'],
      triggers: [
        { type: 'phrase', value: 'roundtrip' },
        { type: 'keyword', value: 'rt' },
        { type: 'regex', pattern: '^rt\\d+$', flags: 'i' },
      ],
    });
    const skillMd = result.artifacts.find((a) => a.path.endsWith('SKILL.md'))!;
    const parsed = parseSkillDocument(skillMd.contents);
    expect(parsed.id).toBe('roundtrip');
    expect(parsed.frontmatter.tags).toEqual(['t1']);
    expect(parsed.frontmatter.triggers).toHaveLength(3);
    expect(parsed.frontmatter.triggers[2]).toMatchObject({
      type: 'regex',
      pattern: '^rt\\d+$',
      flags: 'i',
    });
  });

  it('hash is deterministic across calls with same input', () => {
    const a = skillify({
      id: 'h',
      description: 'd',
      triggers: [{ type: 'phrase', value: 'p' }],
    });
    const b = skillify({
      id: 'h',
      description: 'd',
      triggers: [{ type: 'phrase', value: 'p' }],
    });
    expect(a.hash).toBe(b.hash);
  });
});
