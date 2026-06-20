/**
 * @packageDocumentation
 * @module skills/cli
 * @description
 * Programmable CLI for the skillify lifecycle. Exposes a `runSkillsCli`
 * function so tests can drive commands without spawning a subprocess.
 * A thin shim under `bin/` wraps this for end-user invocation.
 *
 * Supported commands:
 *   - `skillify <id> --description "..." --trigger phrase:"..."` — scaffold.
 *   - `check-resolvable <pack-dir>` — exit-code gate for CI.
 *   - `dry-audit <pack-dir>` — flag overlap.
 *   - `add <pack-dir>` — preflight + load a pack (prints summary).
 */

import { SkillRegistry } from './SkillRegistry';
import { loadSkillPack, writeSkillArtifacts } from './SkillPack';
import { checkResolvable } from './audit';
import { dryAudit } from './audit';
import { skillify, type SkillifyInput } from './skillify';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliIO {
  /** Working directory for relative paths. */
  cwd: string;
  /** Inject a writer for testability (default: real fs). */
  writeArtifacts?: typeof writeSkillArtifacts;
  /** Inject a pack loader for testability. */
  loadPack?: typeof loadSkillPack;
}

/** Entry point — pure function over argv. */
export async function runSkillsCli(
  argv: string[],
  io: CliIO,
): Promise<CliResult> {
  const [cmd, ...rest] = argv;
  const out: string[] = [];
  const err: string[] = [];

  try {
    switch (cmd) {
      case 'skillify':
        return doSkillify(rest, io);
      case 'check-resolvable':
        return doCheckResolvable(rest, io);
      case 'dry-audit':
        return doDryAudit(rest, io);
      case 'add':
        return doAdd(rest, io);
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        out.push(helpText());
        return { exitCode: 0, stdout: out.join('\n'), stderr: '' };
      default:
        err.push(`Unknown command: ${cmd}\n${helpText()}`);
        return { exitCode: 2, stdout: '', stderr: err.join('\n') };
    }
  } catch (e) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Error: ${(e as Error).message}`,
    };
  }
}

function helpText(): string {
  return [
    'veridex skills <command> [options]',
    '',
    'Commands:',
    '  skillify <id>           Scaffold a new skill via the 10-step lifecycle',
    '  check-resolvable <dir>  Verify every skill in a pack is resolvable',
    '  dry-audit <dir>         Flag overlapping skills across a pack',
    '  add <dir>               Load + summarise a skill pack',
    '',
    'Options for `skillify`:',
    '  --description "..."     One-sentence description (required)',
    '  --kind <kind>           workflow|reference|recovery|integration|generic',
    '  --tag <name>            Repeatable; tags for the skill',
    '  --trigger <type:value>  Repeatable; types: keyword, phrase, regex, intent',
    '  --failure-trace <path>  Read a failure trace from this file',
    '  --out-dir <path>        Override output root (default: ./)',
  ].join('\n');
}

// ── Sub-commands ───────────────────────────────────────────────────────────

function doSkillify(argv: string[], io: CliIO): CliResult {
  const id = argv[0];
  if (!id) {
    return { exitCode: 2, stdout: '', stderr: 'skillify: <id> is required' };
  }
  const flags = parseFlags(argv.slice(1));
  const description = flags.description?.[0];
  if (!description) {
    return { exitCode: 2, stdout: '', stderr: 'skillify: --description is required' };
  }

  const triggers: SkillifyInput['triggers'] = [];
  for (const t of flags.trigger ?? []) {
    const idx = t.indexOf(':');
    if (idx <= 0) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: `skillify: --trigger expects format "type:value" (got "${t}")`,
      };
    }
    const type = t.slice(0, idx).trim();
    const value = t.slice(idx + 1).trim();
    if (type === 'regex') {
      triggers.push({ type: 'regex', pattern: value });
    } else if (type === 'keyword' || type === 'phrase' || type === 'intent') {
      triggers.push({ type, value });
    } else {
      return {
        exitCode: 2,
        stdout: '',
        stderr: `skillify: unknown trigger type "${type}"`,
      };
    }
  }

  const input: SkillifyInput = {
    id,
    description,
    kind: flags.kind?.[0],
    tags: flags.tag,
    triggers,
  };

  const result = skillify(input);
  const writer = io.writeArtifacts ?? writeSkillArtifacts;
  const outDir = flags['out-dir']?.[0] ?? io.cwd;
  const written = writer(outDir, result.artifacts);
  return {
    exitCode: 0,
    stdout: [
      `Scaffolded skill "${result.id}" (hash ${result.hash})`,
      `Wrote ${written.length} files under ${result.rootDir}`,
      ...written.map((f) => `  + ${f}`),
    ].join('\n'),
    stderr: '',
  };
}

function doCheckResolvable(argv: string[], io: CliIO): CliResult {
  const dir = argv[0];
  if (!dir) {
    return { exitCode: 2, stdout: '', stderr: 'check-resolvable: <dir> is required' };
  }
  const { skills, warnings } = (io.loadPack ?? loadSkillPack)(dir);
  const reg = new SkillRegistry();
  reg.registerMany(skills);
  const issues = checkResolvable(reg);
  const stdoutLines = [
    `Loaded ${skills.length} skills from ${dir}`,
    ...warnings.map((w) => `WARN: ${w}`),
  ];
  if (issues.length === 0) {
    stdoutLines.push('OK: every skill is resolvable.');
    return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: '' };
  }
  for (const i of issues) {
    stdoutLines.push(`FAIL [${i.kind}]: ${i.message}`);
  }
  return { exitCode: 1, stdout: stdoutLines.join('\n'), stderr: '' };
}

function doDryAudit(argv: string[], io: CliIO): CliResult {
  const dir = argv[0];
  if (!dir) {
    return { exitCode: 2, stdout: '', stderr: 'dry-audit: <dir> is required' };
  }
  const { skills, warnings } = (io.loadPack ?? loadSkillPack)(dir);
  const reg = new SkillRegistry();
  reg.registerMany(skills);
  const issues = dryAudit(reg);
  const lines = [
    `Loaded ${skills.length} skills from ${dir}`,
    ...warnings.map((w) => `WARN: ${w}`),
  ];
  if (issues.length === 0) {
    lines.push('OK: no overlapping skills detected.');
    return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
  }
  for (const i of issues) {
    lines.push(`WARN [${i.kind}]: ${i.message}`);
  }
  // DRY findings are warnings, not failures — pipeline tunables can elevate them.
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}

function doAdd(argv: string[], io: CliIO): CliResult {
  const dir = argv[0];
  if (!dir) {
    return { exitCode: 2, stdout: '', stderr: 'add: <dir> is required' };
  }
  const { manifest, skills, warnings } = (io.loadPack ?? loadSkillPack)(dir);
  const lines = [
    `Pack: ${manifest.id}${manifest.version ? `@${manifest.version}` : ''}`,
    `Skills: ${skills.length}`,
    ...skills.map((s) => `  - ${s.id} — ${s.frontmatter.description}`),
    ...warnings.map((w) => `WARN: ${w}`),
  ];
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}

// ── Tiny flag parser ──────────────────────────────────────────────────────

function parseFlags(argv: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      out[key] = (out[key] ?? []).concat('true');
    } else {
      out[key] = (out[key] ?? []).concat(v);
      i += 1;
    }
  }
  return out;
}
