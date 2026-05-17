/**
 * @packageDocumentation
 * @module skills/SkillRegistry
 * @description
 * In-memory registry for {@link SkillContract}s with progressive
 * disclosure. Only frontmatter (summaries) are surfaced in the prompt;
 * the body is fetched explicitly via `load_skill(id)` or
 * {@link SkillRegistry.load}.
 */

import type {
  SkillContract,
  SkillFrontmatter,
  SkillMatch,
  SkillSummary,
} from './types';

/** Lookup function — returns the contract for a given id, if any. */
export type SkillLookup = (id: string) => SkillContract | undefined;

/** Registry storing skills + offering summary projection. */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillContract>();

  /** Register a skill. Throws on duplicate id (call `replace()` to update). */
  register(skill: SkillContract): void {
    if (this.skills.has(skill.id)) {
      throw new Error(
        `SkillRegistry: skill "${skill.id}" already registered. Call replace() to update.`,
      );
    }
    this.skills.set(skill.id, skill);
  }

  /** Insert or update — used by pack loaders. */
  replace(skill: SkillContract): void {
    this.skills.set(skill.id, skill);
  }

  /** Bulk register; reports duplicate ids without aborting. */
  registerMany(skills: ReadonlyArray<SkillContract>): {
    registered: number;
    duplicates: string[];
  } {
    const duplicates: string[] = [];
    let registered = 0;
    for (const s of skills) {
      if (this.skills.has(s.id)) {
        duplicates.push(s.id);
        continue;
      }
      this.skills.set(s.id, s);
      registered += 1;
    }
    return { registered, duplicates };
  }

  /** Remove a skill. Returns true if removed. */
  unregister(id: string): boolean {
    return this.skills.delete(id);
  }

  /** Fetch full contract (with body). */
  load(id: string): SkillContract | undefined {
    return this.skills.get(id);
  }

  /** Same as `load`, but returns just the frontmatter summary. */
  summary(id: string): SkillSummary | undefined {
    const s = this.skills.get(id);
    return s ? frontmatterToSummary(s.frontmatter) : undefined;
  }

  /** All skill summaries, sorted by id for stable prompt caching. */
  list(): SkillSummary[] {
    return [...this.skills.values()]
      .map((s) => frontmatterToSummary(s.frontmatter))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** All full contracts. Avoid surfacing to the model directly. */
  values(): SkillContract[] {
    return [...this.skills.values()];
  }

  /** Number of skills registered. */
  size(): number {
    return this.skills.size;
  }

  /** Build a render-ready disclosed catalog string. */
  renderDisclosedCatalog(): string {
    const list = this.list();
    if (list.length === 0) return '';
    const lines = list.map(
      (s) =>
        `- ${s.id} [${s.kind}] — ${s.description}${
          s.tags.length ? `  (tags: ${s.tags.join(', ')})` : ''
        }`,
    );
    lines.push(
      '',
      'This catalog shows skill summaries only. Call `load_skill(id)` to fetch the full body before applying.',
    );
    return lines.join('\n');
  }

  /** Stable lookup binding for the `load_skill` built-in. */
  lookup: SkillLookup = (id) => this.skills.get(id);
}

export function frontmatterToSummary(fm: SkillFrontmatter): SkillSummary {
  return {
    id: fm.id,
    name: fm.name,
    description: fm.description,
    kind: fm.kind ?? 'generic',
    tags: fm.tags ?? [],
    triggers: fm.triggers ?? [],
    packId: fm.packId,
  };
}

/** Render the full body + frontmatter section for a single skill. */
export function renderSkillDetail(skill: SkillContract): string {
  const fm = skill.frontmatter;
  const parts: string[] = [
    `Skill: ${fm.id}${fm.name && fm.name !== fm.id ? ` (${fm.name})` : ''}`,
    `Kind: ${fm.kind ?? 'generic'}`,
    fm.tags && fm.tags.length ? `Tags: ${fm.tags.join(', ')}` : null,
    fm.version ? `Version: ${fm.version}` : null,
    fm.packId ? `Pack: ${fm.packId}` : null,
    '',
    fm.description,
    '',
    skill.body || '(empty body)',
  ].filter((p): p is string => p !== null);

  if (skill.scripts && skill.scripts.length) {
    parts.push('', 'Scripts:');
    for (const s of skill.scripts) {
      parts.push(`  - ${s.name} (${s.path})${s.description ? ' — ' + s.description : ''}`);
    }
  }
  if (skill.tools && skill.tools.length) {
    parts.push('', 'Tools:');
    for (const t of skill.tools) {
      parts.push(`  - ${t.name}${t.description ? ' — ' + t.description : ''}`);
    }
  }
  return parts.join('\n');
}

export type { SkillMatch };
