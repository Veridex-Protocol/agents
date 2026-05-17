/**
 * @packageDocumentation
 * @module skills/SkillPack
 * @description
 * Skill-pack format and filesystem loader.
 *
 * A **skill pack** is a directory (or installed npm package) with this
 * shape:
 * ```
 * <root>/
 *   pack.json           # { id, version, description, skills?: string[] }
 *   <skill_a>/SKILL.md
 *   <skill_b>/SKILL.md
 *   ...
 * ```
 *
 * `pack.json` is optional — when absent, every `*SKILL.md` is loaded
 * and the pack id defaults to the directory basename.
 *
 * The loader is dep-free (node:fs only), synchronous, and emits warnings
 * instead of throwing on individual skill parse failures so a single
 * broken skill cannot break the runtime.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSkillDocument, hashSkillContent } from './parser';
import type { SkillContract, SkillSource } from './types';

/** `pack.json` manifest. All fields optional except `id`. */
export interface SkillPackManifest {
  id: string;
  version?: string;
  description?: string;
  /** Explicit list of skill dirs (relative to manifest). When absent: auto-discover. */
  skills?: string[];
  metadata?: Record<string, unknown>;
}

export interface LoadedSkillPack {
  manifest: SkillPackManifest;
  skills: SkillContract[];
  warnings: string[];
  /** Pack root directory (absolute). */
  rootDir: string;
}

export interface LoadSkillPackOptions {
  /** Override pack id (defaults to manifest.id or directory basename). */
  packId?: string;
  /** Synchronous file reader injection (for tests). */
  readFile?: (p: string) => string;
  /** Synchronous directory reader injection (for tests). */
  readDir?: (p: string) => string[];
  /** Stat predicate injection (returns true if path is a directory). */
  isDirectory?: (p: string) => boolean;
}

/** Load a skill pack from a filesystem directory. */
export function loadSkillPack(
  rootDir: string,
  options: LoadSkillPackOptions = {},
): LoadedSkillPack {
  const readFile = options.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  const readDir = options.readDir ?? ((p) => fs.readdirSync(p));
  const isDir = options.isDirectory ?? ((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });

  const warnings: string[] = [];
  const manifestPath = path.join(rootDir, 'pack.json');

  let manifest: SkillPackManifest;
  try {
    const raw = readFile(manifestPath);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
      throw new Error('manifest must declare a string "id"');
    }
    manifest = parsed;
  } catch (e) {
    // Missing or invalid manifest — synthesise one.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`pack.json at ${manifestPath} is invalid: ${(e as Error).message}. Using directory basename as id.`);
    }
    manifest = {
      id: options.packId ?? path.basename(rootDir),
    };
  }
  if (options.packId) manifest.id = options.packId;

  const skillDirs = (manifest.skills && manifest.skills.length > 0)
    ? manifest.skills
    : discoverSkillDirs(rootDir, readDir, isDir);

  const skills: SkillContract[] = [];
  for (const rel of skillDirs) {
    const skillMdPath = path.join(rootDir, rel, 'SKILL.md');
    try {
      const raw = readFile(skillMdPath);
      const parsed = parseSkillDocument(raw, {
        filename: skillMdPath,
        source: {
          kind: 'pack',
          packId: manifest.id,
          path: skillMdPath,
          hash: hashSkillContent(raw),
        } satisfies SkillSource,
      });
      // Ensure pack id appears on frontmatter for resolver / DRY.
      parsed.frontmatter.packId = manifest.id;
      skills.push(parsed);
    } catch (e) {
      warnings.push(
        `Failed to load skill at ${skillMdPath}: ${(e as Error).message}`,
      );
    }
  }

  return { manifest, skills, warnings, rootDir };
}

function discoverSkillDirs(
  rootDir: string,
  readDir: (p: string) => string[],
  isDir: (p: string) => boolean,
): string[] {
  let entries: string[];
  try {
    entries = readDir(rootDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = path.join(rootDir, entry);
    if (!isDir(full)) continue;
    // Cheap probe — does this dir contain SKILL.md?
    try {
      const sub = readDir(full);
      if (sub.includes('SKILL.md')) out.push(entry);
    } catch {
      // skip
    }
  }
  return out.sort();
}

/** Write a {@link SkillifyResult} or a list of artifacts to disk. */
export function writeSkillArtifacts(
  rootDir: string,
  artifacts: ReadonlyArray<{ path: string; contents: string }>,
  options: { writeFile?: (p: string, c: string) => void; mkdir?: (p: string) => void } = {},
): string[] {
  const writeFile =
    options.writeFile ?? ((p, c) => fs.writeFileSync(p, c, 'utf8'));
  const mkdir =
    options.mkdir ??
    ((p) => fs.mkdirSync(p, { recursive: true }));
  const written: string[] = [];
  for (const a of artifacts) {
    const full = path.join(rootDir, a.path);
    mkdir(path.dirname(full));
    writeFile(full, a.contents);
    written.push(full);
  }
  return written;
}
