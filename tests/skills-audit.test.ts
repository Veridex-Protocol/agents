import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../src/skills/SkillRegistry';
import { checkResolvable, dryAudit } from '../src/skills/audit';
import type { SkillContract } from '../src/skills/types';

function mk(
  id: string,
  triggers: SkillContract['frontmatter']['triggers'],
  body = `body-${id}`,
): SkillContract {
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
    body,
    source: { kind: 'inline' },
  };
}

describe('audit/check-resolvable', () => {
  it('flags skills with no triggers', () => {
    const r = new SkillRegistry();
    r.register(mk('empty', []));
    const issues = checkResolvable(r);
    expect(issues.find((i) => i.kind === 'no_triggers')?.skillId).toBe('empty');
  });

  it('flags invalid regex', () => {
    const r = new SkillRegistry();
    r.register(mk('bad', [{ type: 'regex', pattern: '(' }]));
    const issues = checkResolvable(r);
    expect(issues.some((i) => i.kind === 'invalid_regex' && i.skillId === 'bad')).toBe(true);
  });

  it('flags shadowed skills', () => {
    const r = new SkillRegistry();
    // Two skills share keyword 'pay'; the one with extra phrase wins on probes.
    r.register(mk('weak', [{ type: 'keyword', value: 'pay' }]));
    r.register(
      mk('strong', [
        { type: 'phrase', value: 'pay' },
        { type: 'keyword', value: 'pay' },
      ]),
    );
    const issues = checkResolvable(r);
    const shadow = issues.find((i) => i.kind === 'shadowed_by_another_skill' && i.skillId === 'weak');
    expect(shadow).toBeDefined();
    expect(shadow?.rival).toBe('strong');
  });

  it('passes when each skill wins its own probe', () => {
    const r = new SkillRegistry();
    r.register(mk('a', [{ type: 'phrase', value: 'alpha' }]));
    r.register(mk('b', [{ type: 'phrase', value: 'bravo' }]));
    expect(checkResolvable(r)).toHaveLength(0);
  });
});

describe('audit/dry-audit', () => {
  it('detects identical bodies', () => {
    const r = new SkillRegistry();
    r.register(mk('a', [{ type: 'phrase', value: 'x' }], 'shared body'));
    r.register(mk('b', [{ type: 'phrase', value: 'y' }], 'shared body'));
    const issues = dryAudit(r);
    expect(issues.some((i) => i.kind === 'identical_body')).toBe(true);
  });

  it('detects duplicate triggers', () => {
    const r = new SkillRegistry();
    r.register(mk('a', [{ type: 'keyword', value: 'pay' }]));
    r.register(mk('b', [{ type: 'keyword', value: 'pay' }]));
    const issues = dryAudit(r);
    expect(issues.some((i) => i.kind === 'duplicate_trigger')).toBe(true);
  });

  it('detects high keyword overlap (Jaccard)', () => {
    const r = new SkillRegistry();
    r.register(
      mk('a', [
        { type: 'keyword', value: 'pay' },
        { type: 'keyword', value: 'transfer' },
        { type: 'keyword', value: 'send' },
      ]),
    );
    r.register(
      mk('b', [
        { type: 'keyword', value: 'pay' },
        { type: 'keyword', value: 'transfer' },
        { type: 'keyword', value: 'send' },
        { type: 'keyword', value: 'extra' },
      ]),
    );
    const issues = dryAudit(r, { keywordOverlapThreshold: 0.5 });
    expect(issues.some((i) => i.kind === 'overlapping_keywords')).toBe(true);
  });
});
