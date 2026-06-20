/**
 * @packageDocumentation
 * @module skills/parser
 * @description
 * Parse a `SKILL.md` file into a {@link SkillContract}.
 *
 * Frontmatter is a tiny YAML subset — we do not pull in the `yaml`
 * dependency here (core is dep-light). Authors who need full YAML can
 * pass a custom parser via `parseSkillDocument(content, { yaml })`.
 *
 * Supported subset:
 *   - `key: value`
 *   - `key:` followed by indented `- item` list entries (string lists)
 *   - Quoted strings: `key: "with spaces"` or `key: 'with spaces'`
 *   - Booleans, numbers, null
 *   - Nested objects up to one level via `key:` + `  subkey: value`
 *
 * For complex frontmatter, install `yaml` and pass it explicitly:
 * ```ts
 * import * as yaml from 'yaml';
 * parseSkillDocument(content, { yaml: { parse: yaml.parse } });
 * ```
 */

import { createHash } from 'node:crypto';
import type {
  SkillContract,
  SkillFrontmatter,
  SkillSource,
  SkillTrigger,
} from './types';

/** Optional injected YAML parser (e.g. the `yaml` package). */
export interface YamlParser {
  parse(input: string): unknown;
}

export interface ParseSkillOptions {
  /** Source provenance. Defaults to `{ kind: 'inline' }`. */
  source?: SkillSource;
  /** Provide a real YAML parser when frontmatter exceeds the built-in subset. */
  yaml?: YamlParser;
  /** Override default filename used in errors / source. */
  filename?: string;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/** Compute a short content hash (first 16 hex chars of sha256). */
export function hashSkillContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Parse a `SKILL.md` document into a `SkillContract`.
 *
 * @throws if `frontmatter.id` is missing — every skill MUST declare an id.
 */
export function parseSkillDocument(
  content: string,
  options: ParseSkillOptions = {},
): SkillContract {
  const match = content.match(FRONTMATTER_RE);
  const filename = options.filename ?? 'SKILL.md';

  let rawFrontmatter: Record<string, unknown> = {};
  let body = content;

  if (match) {
    const [, fmBlock, mdBody] = match;
    body = (mdBody ?? '').trim();
    const parser = options.yaml ?? builtinYaml;
    const parsed = parser.parse(fmBlock);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      rawFrontmatter = parsed as Record<string, unknown>;
    } else {
      throw new Error(
        `parseSkillDocument(${filename}): frontmatter must be a YAML mapping; got ${typeof parsed}.`,
      );
    }
  }

  const frontmatter = normaliseFrontmatter(rawFrontmatter, filename);

  const source: SkillSource = {
    kind: options.source?.kind ?? 'inline',
    packId: options.source?.packId ?? frontmatter.packId,
    path: options.source?.path,
    hash: options.source?.hash ?? hashSkillContent(content),
  };

  return {
    id: frontmatter.id,
    frontmatter,
    body,
    scripts: extractRefList(rawFrontmatter.scripts, ['name', 'path']) as
      | SkillContract['scripts']
      | undefined,
    tools: extractRefList(rawFrontmatter.tools, ['name']) as
      | SkillContract['tools']
      | undefined,
    tests: extractRefList(rawFrontmatter.tests, ['name', 'path', 'kind']) as
      | SkillContract['tests']
      | undefined,
    source,
  };
}

// ── Normalisation ───────────────────────────────────────────────────────────

function normaliseFrontmatter(
  raw: Record<string, unknown>,
  filename: string,
): SkillFrontmatter {
  const id = stringOrUndef(raw.id) ?? stringOrUndef(raw.name);
  if (!id) {
    throw new Error(
      `parseSkillDocument(${filename}): frontmatter.id is required (or frontmatter.name as fallback).`,
    );
  }
  const description =
    stringOrUndef(raw.description) ??
    'Imported skill — no description provided.';
  const tags = stringListOrUndef(raw.tags) ?? [];
  const triggers = normaliseTriggers(raw.triggers);
  const kind = (stringOrUndef(raw.kind) ?? 'generic') as SkillFrontmatter['kind'];

  return {
    ...raw,
    id,
    name: stringOrUndef(raw.name) ?? id,
    description,
    kind,
    tags,
    triggers,
    version: stringOrUndef(raw.version),
    packId: stringOrUndef(raw.packId),
  };
}

function normaliseTriggers(raw: unknown): SkillTrigger[] {
  if (!raw) return [];
  if (!Array.isArray(raw)) return [];
  const out: SkillTrigger[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      // Default: phrase trigger.
      out.push({ type: 'phrase', value: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const type = stringOrUndef(o.type);
    if (type === 'keyword' && typeof o.value === 'string') {
      out.push({ type: 'keyword', value: o.value });
    } else if (type === 'phrase' && typeof o.value === 'string') {
      out.push({ type: 'phrase', value: o.value });
    } else if (type === 'regex' && typeof o.pattern === 'string') {
      out.push({
        type: 'regex',
        pattern: o.pattern,
        flags: stringOrUndef(o.flags),
      });
    } else if (type === 'intent' && typeof o.value === 'string') {
      out.push({ type: 'intent', value: o.value });
    }
  }
  return out;
}

function extractRefList(
  raw: unknown,
  requiredKeys: string[],
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const o = entry as Record<string, unknown>;
    if (requiredKeys.every((k) => typeof o[k] === 'string')) {
      out.push(o);
    }
  }
  return out.length ? out : undefined;
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function stringListOrUndef(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length ? out : undefined;
}

// ── Built-in tiny YAML subset ──────────────────────────────────────────────
//
// Handles `key: value`, quoted strings, simple scalars, and `- item` lists.
// For nested objects, supports one level of indentation. NOT a full YAML
// parser — authors who need that should pass `options.yaml`.

interface YamlFrame {
  indent: number;
  /** Current container the frame writes into (object or array). */
  container: any;
  /** Parent container (used to promote `{}` to `[]` on first list item). */
  parent?: any;
  /** Key under `parent` that this frame fills. */
  parentKey?: string;
}

const builtinYaml: YamlParser = {
  parse(input: string): unknown {
    const lines = input.split('\n');
    const root: Record<string, unknown> = {};
    const stack: YamlFrame[] = [{ indent: -1, container: root }];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      const indent = raw.match(/^ */)![0].length;
      const trimmed = raw.trim();

      // Pop frames whose indent is >= current indent (siblings or outer).
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
        stack.pop();
      }
      const top = stack[stack.length - 1];

      // ── List item ───────────────────────────────────────────────────────
      if (trimmed.startsWith('- ')) {
        // Promote the current frame's empty-object placeholder to an array
        // if necessary.
        let target: unknown[];
        if (Array.isArray(top.container)) {
          target = top.container;
        } else if (
          top.parent !== undefined &&
          top.parentKey !== undefined &&
          isEmptyObject(top.container)
        ) {
          const arr: unknown[] = [];
          top.parent[top.parentKey] = arr;
          top.container = arr;
          target = arr;
        } else {
          throw new Error(
            `builtin YAML: list item with no parent key at line ${i + 1}`,
          );
        }

        const itemRaw = trimmed.slice(2).trim();
        if (itemRaw.includes(':') && !looksLikeQuotedScalar(itemRaw)) {
          // Object-shaped list item.
          const obj: Record<string, unknown> = {};
          target.push(obj);
          const { key: k, value, isBlock } = parseKV(itemRaw);
          if (!isBlock) obj[k] = value;
          // Push a frame so subsequent deeper-indented `key: value` lines
          // populate this obj. Use indent + 2 (after the `- `) so the
          // frame's own indent reflects the object's effective position.
          stack.push({
            indent: indent + 1,
            container: obj,
          });
          // If first key was block (`- key:`), remember it as a pending key
          // so a nested list/object can attach.
          if (isBlock) {
            obj[k] = {};
            stack.push({
              indent: indent + 2,
              container: obj[k],
              parent: obj,
              parentKey: k,
            });
          }
        } else {
          target.push(parseScalar(itemRaw));
        }
        continue;
      }

      // ── Key: value ─────────────────────────────────────────────────────
      if (trimmed.includes(':')) {
        const { key, value, isBlock } = parseKV(trimmed);
        // If the top frame is an array, this key extends the last object
        // pushed onto it (e.g. `- type: phrase\n    value: hello`).
        if (Array.isArray(top.container)) {
          throw new Error(
            `builtin YAML: bare key "${key}" inside list at line ${i + 1}`,
          );
        }
        const container = top.container as Record<string, unknown>;
        if (isBlock) {
          container[key] = {};
          stack.push({
            indent,
            container: container[key],
            parent: container,
            parentKey: key,
          });
        } else {
          container[key] = value;
        }
      }
    }
    return root;
  },
};

function isEmptyObject(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v as Record<string, unknown>).length === 0
  );
}

function looksLikeQuotedScalar(s: string): boolean {
  return (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  );
}

function parseKV(line: string): { key: string; value: unknown; isBlock: boolean } {
  const colonIdx = line.indexOf(':');
  const key = line.slice(0, colonIdx).trim();
  const rest = line.slice(colonIdx + 1).trim();
  if (rest.length === 0) return { key, value: null, isBlock: true };
  return { key, value: parseScalar(rest), isBlock: false };
}

function parseScalar(s: string): unknown {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  // Inline list `[a, b, c]` — naive split.
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((part) => parseScalar(part.trim()));
  }
  return s;
}
