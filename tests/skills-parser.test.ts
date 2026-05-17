import { describe, it, expect } from 'vitest';
import { parseSkillDocument, hashSkillContent } from '../src/skills/parser';

describe('skills/parser', () => {
  it('parses minimal frontmatter + body', () => {
    const md = `---\nid: hello_skill\nname: Hello\ndescription: Say hi politely.\nkind: workflow\ntriggers:\n  - greet\n  - type: phrase\n    value: hello\n---\n# Hello\n\nBody here.\n`;
    const s = parseSkillDocument(md);
    expect(s.id).toBe('hello_skill');
    expect(s.frontmatter.description).toBe('Say hi politely.');
    expect(s.frontmatter.kind).toBe('workflow');
    expect(s.frontmatter.triggers).toHaveLength(2);
    // bare string trigger is normalised to phrase
    expect(s.frontmatter.triggers[0]).toMatchObject({ type: 'phrase', value: 'greet' });
    expect(s.frontmatter.triggers[1]).toMatchObject({ type: 'phrase', value: 'hello' });
    expect(s.body).toContain('# Hello');
  });

  it('supports quoted strings, tags, and inline list', () => {
    const md = `---\nid: q\nname: q\ndescription: 'a: colon-y description'\ntags: [alpha, beta]\ntriggers:\n  - type: keyword\n    value: foo\n---\nbody`;
    const s = parseSkillDocument(md);
    expect(s.frontmatter.description).toBe('a: colon-y description');
    expect(s.frontmatter.tags).toEqual(['alpha', 'beta']);
  });

  it('parses regex triggers with flags', () => {
    const md = `---\nid: r\nname: r\ndescription: rgx\ntriggers:\n  - type: regex\n    pattern: '^foo.*bar$'\n    flags: 'i'\n---\nx`;
    const s = parseSkillDocument(md);
    expect(s.frontmatter.triggers[0]).toMatchObject({
      type: 'regex',
      pattern: '^foo.*bar$',
      flags: 'i',
    });
  });

  it('throws when neither id nor name is present', () => {
    expect(() => parseSkillDocument('no frontmatter here')).toThrow();
    expect(() =>
      parseSkillDocument(`---\ndescription: x\ntriggers:\n  - foo\n---\nb`),
    ).toThrow();
  });

  it('falls back to name when id missing', () => {
    const s = parseSkillDocument(
      `---\nname: fallback_id\ndescription: x\ntriggers:\n  - foo\n---\nb`,
    );
    expect(s.id).toBe('fallback_id');
  });

  it('hashSkillContent is deterministic', () => {
    const a = hashSkillContent('alpha');
    const b = hashSkillContent('alpha');
    const c = hashSkillContent('beta');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('accepts injected yaml parser', () => {
    const md = `---\nid: x\nname: x\ndescription: x\ntriggers:\n  - foo\n---\nbody`;
    const calls: string[] = [];
    const s = parseSkillDocument(md, {
      yaml: {
        parse(raw) {
          calls.push(raw);
          return {
            id: 'x',
            name: 'x',
            description: 'x',
            triggers: ['foo'],
          };
        },
      },
    });
    expect(calls.length).toBe(1);
    expect(s.id).toBe('x');
  });
});
