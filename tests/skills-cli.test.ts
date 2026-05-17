import { describe, it, expect, vi } from 'vitest';
import { runSkillsCli } from '../src/skills/cli';

describe('skills/cli', () => {
  it('help prints usage', async () => {
    const r = await runSkillsCli(['help'], { cwd: '/tmp' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('veridex skills <command>');
  });

  it('unknown command exits 2', async () => {
    const r = await runSkillsCli(['nope'], { cwd: '/tmp' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Unknown command');
  });

  it('skillify writes artifacts via injected writer', async () => {
    const writer = vi.fn((_root: string, artifacts: ReadonlyArray<{ path: string; contents: string }>) => artifacts.map((a) => `${_root}/${a.path}`));
    const r = await runSkillsCli(
      [
        'skillify',
        'demo_skill',
        '--description',
        'Demo description',
        '--trigger',
        'phrase:demo_skill',
      ],
      { cwd: '/tmp', writeArtifacts: writer as any },
    );
    expect(r.exitCode).toBe(0);
    expect(writer).toHaveBeenCalledOnce();
    expect(writer.mock.calls[0][1]).toHaveLength(10);
    expect(r.stdout).toContain('Scaffolded skill "demo_skill"');
  });

  it('skillify requires id and description', async () => {
    const a = await runSkillsCli(['skillify'], { cwd: '/tmp' });
    expect(a.exitCode).toBe(2);
    const b = await runSkillsCli(['skillify', 'x'], { cwd: '/tmp' });
    expect(b.exitCode).toBe(2);
    expect(b.stderr).toContain('--description');
  });

  it('check-resolvable exits 1 when issues exist', async () => {
    const loadPack = () => ({
      manifest: { id: 'p' },
      rootDir: '/p',
      warnings: [],
      skills: [
        {
          id: 'empty',
          frontmatter: {
            id: 'empty',
            name: 'empty',
            description: 'd',
            kind: 'workflow' as const,
            tags: [],
            triggers: [],
          },
          body: 'b',
          source: { kind: 'inline' as const },
        },
      ],
    });
    const r = await runSkillsCli(['check-resolvable', '/p'], {
      cwd: '/tmp',
      loadPack: loadPack as any,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('FAIL');
  });

  it('dry-audit reports warnings but exits 0', async () => {
    const loadPack = () => ({
      manifest: { id: 'p' },
      rootDir: '/p',
      warnings: [],
      skills: [
        {
          id: 'a',
          frontmatter: {
            id: 'a',
            name: 'a',
            description: 'd',
            kind: 'workflow' as const,
            tags: [],
            triggers: [{ type: 'keyword' as const, value: 'pay' }],
          },
          body: 'b1',
          source: { kind: 'inline' as const },
        },
        {
          id: 'b',
          frontmatter: {
            id: 'b',
            name: 'b',
            description: 'd',
            kind: 'workflow' as const,
            tags: [],
            triggers: [{ type: 'keyword' as const, value: 'pay' }],
          },
          body: 'b2',
          source: { kind: 'inline' as const },
        },
      ],
    });
    const r = await runSkillsCli(['dry-audit', '/p'], {
      cwd: '/tmp',
      loadPack: loadPack as any,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('duplicate_trigger');
  });
});
