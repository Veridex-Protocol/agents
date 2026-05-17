import { describe, it, expect, vi } from 'vitest';
import { SkillRegistry } from '../src/skills/SkillRegistry';
import { SkillResolver } from '../src/skills/SkillResolver';
import {
  createLoadSkillBuiltin,
  createFindSkillsBuiltin,
  createSkillManageBuiltin,
} from '../src/skills/SkillTools';
import { parseSkillDocument } from '../src/skills/parser';
import type { SkillContract } from '../src/skills/types';

function mk(id: string): SkillContract {
  return {
    id,
    frontmatter: {
      id,
      name: id,
      description: `desc-${id}`,
      kind: 'workflow',
      tags: [],
      triggers: [{ type: 'phrase', value: id }],
    },
    body: `body-${id}`,
    source: { kind: 'inline' },
  };
}

async function call(tool: any, input: any) {
  return tool.execute({ input, run: undefined as any, signal: undefined as any });
}

describe('SkillTools', () => {
  it('load_skill returns body on hit, error on miss', async () => {
    const r = new SkillRegistry();
    r.register(mk('alpha'));
    const t = createLoadSkillBuiltin(r);
    const hit = await call(t, { id: 'alpha' });
    expect(hit.success).toBe(true);
    expect(hit.llmOutput).toContain('body-alpha');
    const miss = await call(t, { id: 'ghost' });
    expect(miss.success).toBe(false);
    expect(miss.error).toBe('skill_not_found');
  });

  it('find_skills returns ranked matches', async () => {
    const r = new SkillRegistry();
    r.register(mk('alpha'));
    r.register(mk('beta'));
    const resolver = new SkillResolver(r);
    const t = createFindSkillsBuiltin(resolver);
    const out = await call(t, { intent: 'please run alpha now' });
    expect(out.success).toBe(true);
    expect(out.llmOutput).toContain('alpha');
  });

  it('find_skills returns no-match message when nothing matches', async () => {
    const r = new SkillRegistry();
    r.register(mk('alpha'));
    const resolver = new SkillResolver(r);
    const t = createFindSkillsBuiltin(resolver);
    const out = await call(t, { intent: 'completely unrelated query xyz' });
    expect(out.success).toBe(true);
    expect(out.llmOutput).toMatch(/no registered skill/i);
  });

  it('skill_manage author mode rejects when no handler is registered', async () => {
    const r = new SkillRegistry();
    const resolver = new SkillResolver(r);
    const t = createSkillManageBuiltin({ registry: r, resolver });
    const out = await call(t, {
      mode: 'author',
      id: 'new_skill',
      description: 'new',
      triggers: [{ type: 'phrase', value: 'new_skill' }],
    });
    expect(out.success).toBe(false);
    expect(out.error).toBe('no_approval_handler');
  });

  it('skill_manage author mode honors approval handler and registers on approve', async () => {
    const r = new SkillRegistry();
    const resolver = new SkillResolver(r);
    const onProposal = vi.fn(async () => ({ approved: true }));
    const t = createSkillManageBuiltin({
      registry: r,
      resolver,
      onProposal,
      proposedBy: 'test-agent',
    });
    const out = await call(t, {
      mode: 'author',
      id: 'authored_one',
      description: 'authored at runtime',
      triggers: [{ type: 'phrase', value: 'authored_one' }],
    });
    expect(out.success).toBe(true);
    expect(onProposal).toHaveBeenCalledOnce();
    expect(r.load('authored_one')).toBeDefined();
  });

  it('skill_manage author mode reports rejection', async () => {
    const r = new SkillRegistry();
    const resolver = new SkillResolver(r);
    const t = createSkillManageBuiltin({
      registry: r,
      resolver,
      onProposal: async () => ({ approved: false, reason: 'policy_block' }),
    });
    const out = await call(t, {
      mode: 'author',
      id: 'blocked',
      description: 'x',
      triggers: [{ type: 'phrase', value: 'blocked' }],
    });
    expect(out.success).toBe(false);
    expect(out.error).toBe('proposal_rejected');
    expect(out.llmOutput).toContain('policy_block');
    expect(r.load('blocked')).toBeUndefined();
  });

  it('skill_manage describe mode returns body', async () => {
    const r = new SkillRegistry();
    r.register(mk('described'));
    const resolver = new SkillResolver(r);
    const t = createSkillManageBuiltin({ registry: r, resolver });
    const out = await call(t, { mode: 'describe', id: 'described' });
    expect(out.success).toBe(true);
    expect(out.llmOutput).toContain('body-described');
  });
});
