import { describe, it, expect } from 'vitest';
import { loadSkillPack } from '../src/skills/SkillPack';

const SKILL_MD = `---
id: pack_skill
name: Pack Skill
description: A skill loaded from a pack.
kind: workflow
triggers:
  - type: phrase
    value: pack_skill
---
# pack_skill

Body content.
`;

function fakeFs(files: Record<string, string>, dirs: Record<string, string[]>) {
  return {
    readFile: (p: string) => {
      if (!(p in files)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
    readDir: (p: string) => {
      if (!(p in dirs)) throw new Error(`ENOTDIR: ${p}`);
      return dirs[p];
    },
    isDirectory: (p: string) => p in dirs,
  };
}

describe('SkillPack/loadSkillPack', () => {
  it('loads pack with explicit manifest', () => {
    const root = '/packs/sample';
    const fs = fakeFs(
      {
        [`${root}/pack.json`]: JSON.stringify({
          id: 'sample',
          version: '0.1.0',
          skills: ['pack_skill'],
        }),
        [`${root}/pack_skill/SKILL.md`]: SKILL_MD,
      },
      {
        [root]: ['pack.json', 'pack_skill'],
        [`${root}/pack_skill`]: ['SKILL.md'],
      },
    );
    const pack = loadSkillPack(root, fs);
    expect(pack.manifest.id).toBe('sample');
    expect(pack.skills).toHaveLength(1);
    expect(pack.skills[0].id).toBe('pack_skill');
    expect(pack.skills[0].source.kind).toBe('pack');
    expect(pack.skills[0].source.packId).toBe('sample');
    expect(pack.warnings).toEqual([]);
  });

  it('auto-discovers skills when manifest omits the list', () => {
    const root = '/packs/auto';
    const fs = fakeFs(
      {
        [`${root}/pack.json`]: JSON.stringify({ id: 'auto' }),
        [`${root}/one/SKILL.md`]: SKILL_MD.replace('pack_skill', 'one'),
        [`${root}/two/SKILL.md`]: SKILL_MD.replace(/pack_skill/g, 'two'),
      },
      {
        [root]: ['pack.json', 'one', 'two'],
        [`${root}/one`]: ['SKILL.md'],
        [`${root}/two`]: ['SKILL.md'],
      },
    );
    const pack = loadSkillPack(root, fs);
    expect(pack.skills.map((s) => s.id).sort()).toEqual(['one', 'two']);
  });

  it('synthesises a manifest when pack.json is missing', () => {
    const root = '/packs/loose';
    const fs = fakeFs(
      {
        [`${root}/solo/SKILL.md`]: SKILL_MD.replace(/pack_skill/g, 'solo'),
      },
      {
        [root]: ['solo'],
        [`${root}/solo`]: ['SKILL.md'],
      },
    );
    const pack = loadSkillPack(root, fs);
    expect(pack.manifest.id).toBe('loose');
    expect(pack.skills).toHaveLength(1);
  });

  it('emits warnings for unparseable skill files instead of throwing', () => {
    const root = '/packs/broken';
    const fs = fakeFs(
      {
        [`${root}/pack.json`]: JSON.stringify({ id: 'broken', skills: ['x'] }),
        [`${root}/x/SKILL.md`]: '---\nname:\n---\n', // missing id + name
      },
      {
        [root]: ['pack.json', 'x'],
        [`${root}/x`]: ['SKILL.md'],
      },
    );
    const pack = loadSkillPack(root, fs);
    expect(pack.skills).toHaveLength(0);
    expect(pack.warnings.length).toBeGreaterThan(0);
  });
});
