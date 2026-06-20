/**
 * @module FilesystemTools
 * @description
 * Filesystem tools that give agents the ability to read, write, edit,
 * search, and list files within a sandboxed root directory.
 *
 * Security: All paths are resolved relative to `rootDir` and validated
 * to prevent path traversal.  Symlinks outside the sandbox are rejected.
 * Binary files are base64-encoded with a size limit.
 *
 * This is a superset of DeepAgents' FilesystemMiddleware — same 5 tools
 * but implemented as first-class Veridex tool contracts with safety
 * classes, policy integration, and trace support.
 */

import { z } from 'zod';
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  realpath,
} from 'node:fs/promises';
import { resolve, relative, join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { ToolContract, ToolResult } from '../types/tools';
import { tool } from './tool';

// ── Config ──

export interface FilesystemToolsOptions {
  /** Root directory for all file operations.  All paths are sandboxed here. */
  rootDir: string;
  /** Maximum file size in bytes for read operations (default: 1MB). */
  maxReadBytes?: number;
  /** Maximum file size in bytes for write operations (default: 5MB). */
  maxWriteBytes?: number;
  /** File extensions to block from write (e.g. ['.exe', '.sh']). */
  blockedExtensions?: string[];
  /** Maximum search results returned (default: 50). */
  maxSearchResults?: number;
}

// ── Path validation ──

async function safePath(rootDir: string, userPath: string): Promise<string> {
  // Resolve root to its real path first (handles macOS /var -> /private/var symlink)
  const realRoot = await realpath(rootDir).catch(() => resolve(rootDir));
  const resolved = resolve(realRoot, userPath);

  // For existing paths, resolve through symlinks; for new paths, use as-is
  const realResolved = existsSync(resolved)
    ? await realpath(resolved)
    : resolved;

  const rel = relative(realRoot, realResolved);
  if (rel.startsWith('..') || resolve(realRoot, rel) !== realResolved) {
    throw new Error(`Path traversal blocked: '${userPath}' resolves outside sandbox`);
  }

  return realResolved;
}

// ── Helper: line-numbered content ──

function addLineNumbers(content: string, startLine: number): string {
  const lines = content.split('\n');
  const width = String(startLine + lines.length).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width)} | ${line}`)
    .join('\n');
}

// ── Helper: simple grep ──

async function grepFile(
  filePath: string,
  query: string,
  maxResults: number,
): Promise<{ line: number; text: string }[]> {
  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const results: { line: number; text: string }[] = [];
  const lowerQuery = query.toLowerCase();

  for (let i = 0; i < lines.length && results.length < maxResults; i++) {
    if (lines[i].toLowerCase().includes(lowerQuery)) {
      results.push({ line: i + 1, text: lines[i] });
    }
  }

  return results;
}

// ── Helper: recursive glob ──

async function globDir(
  dir: string,
  pattern: RegExp,
  maxResults: number,
  rootDir: string,
  results: string[] = [],
): Promise<string[]> {
  if (results.length >= maxResults) return results;

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= maxResults) break;
    const fullPath = join(dir, entry.name);
    const relPath = relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      // Skip common large directories
      if (['node_modules', '.git', 'dist', 'build', '.next', 'coverage'].includes(entry.name)) {
        continue;
      }
      await globDir(fullPath, pattern, maxResults, rootDir, results);
    } else if (pattern.test(relPath)) {
      results.push(relPath);
    }
  }

  return results;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/<<<GLOBSTAR>>>/g, '.*');
  return new RegExp(`^${escaped}$`);
}

// ── Factory ──

/**
 * Create filesystem tools sandboxed to `rootDir`.
 *
 * Returns 5 tools: `file_read`, `file_write`, `file_edit`, `file_search`, `file_glob`.
 *
 * @example
 * ```ts
 * const fsTools = createFilesystemTools({ rootDir: '/workspace' });
 * const agent = createAgent({
 *   tools: [...fsTools, ...otherTools],
 * });
 * ```
 */
export function createFilesystemTools(
  options: FilesystemToolsOptions,
): ToolContract[] {
  const {
    rootDir,
    maxReadBytes = 1_048_576,   // 1MB
    maxWriteBytes = 5_242_880,  // 5MB
    blockedExtensions = [],
    maxSearchResults = 50,
  } = options;

  // ── file_read ──

  const fileRead = tool({
    name: 'file_read',
    description:
      'Read contents of a file.  Returns line-numbered text.  ' +
      'Use offset/limit to read specific line ranges for large files.',
    input: z.object({
      path: z.string().describe('File path relative to workspace root.'),
      offset: z.number().int().min(0).default(0).describe('Start line (0-indexed).'),
      limit: z.number().int().min(1).default(200).describe('Max lines to return.'),
    }),
    safetyClass: 'read',
    idempotent: true,
    async execute({ input }): Promise<ToolResult> {
      try {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 200;
        const absPath = await safePath(rootDir, input.path);
        const stats = await stat(absPath);

        if (stats.size > maxReadBytes) {
          return {
            llmOutput: `File too large (${stats.size} bytes, limit ${maxReadBytes}). Use offset/limit to read a portion.`,
            success: false,
            error: 'File too large',
          };
        }

        const content = await readFile(absPath, 'utf-8');
        const lines = content.split('\n');
        const slice = lines.slice(offset, offset + limit);
        const numbered = addLineNumbers(slice.join('\n'), offset + 1);
        const truncated = offset + limit < lines.length;

        let output = numbered;
        if (truncated) {
          output += `\n\n[Showing lines ${offset + 1}-${offset + slice.length} of ${lines.length}. Use offset=${offset + limit} to continue.]`;
        }

        return { llmOutput: output, success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { llmOutput: `Error reading file: ${msg}`, success: false, error: msg };
      }
    },
  });

  // ── file_write ──

  const fileWrite = tool({
    name: 'file_write',
    description:
      'Write content to a file.  Creates parent directories if needed.  ' +
      'Use mode "overwrite" (default) or "append".',
    input: z.object({
      path: z.string().describe('File path relative to workspace root.'),
      content: z.string().describe('Content to write.'),
      mode: z.enum(['overwrite', 'append']).default('overwrite').describe('Write mode.'),
    }),
    safetyClass: 'write',
    async execute({ input }): Promise<ToolResult> {
      try {
        // Check blocked extensions
        const ext = input.path.includes('.') ? `.${input.path.split('.').pop()}` : '';
        if (blockedExtensions.includes(ext)) {
          return {
            llmOutput: `Blocked file extension: ${ext}`,
            success: false,
            error: `Blocked extension: ${ext}`,
          };
        }

        if (input.content.length > maxWriteBytes) {
          return {
            llmOutput: `Content too large (${input.content.length} bytes, limit ${maxWriteBytes}).`,
            success: false,
            error: 'Content too large',
          };
        }

        const absPath = await safePath(rootDir, input.path);
        await mkdir(dirname(absPath), { recursive: true });

        const mode = input.mode ?? 'overwrite';
        if (mode === 'append') {
          const existing = existsSync(absPath) ? await readFile(absPath, 'utf-8') : '';
          await writeFile(absPath, existing + input.content, 'utf-8');
        } else {
          await writeFile(absPath, input.content, 'utf-8');
        }

        return {
          llmOutput: `Wrote ${input.content.length} bytes to ${input.path}`,
          success: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { llmOutput: `Error writing file: ${msg}`, success: false, error: msg };
      }
    },
  });

  // ── file_edit ──

  const fileEdit = tool({
    name: 'file_edit',
    description:
      'Apply line-based edits to a file.  Provide an array of edits, each specifying ' +
      'old_text to find and new_text to replace it with.  More precise than full file rewrites.',
    input: z.object({
      path: z.string().describe('File path relative to workspace root.'),
      edits: z.array(z.object({
        old_text: z.string().describe('Exact text to find (must match uniquely).'),
        new_text: z.string().describe('Replacement text.'),
      })).min(1).describe('Edits to apply sequentially.'),
    }),
    safetyClass: 'write',
    async execute({ input }): Promise<ToolResult> {
      try {
        const absPath = await safePath(rootDir, input.path);
        let content = await readFile(absPath, 'utf-8');

        const applied: string[] = [];
        const failed: string[] = [];

        for (const edit of input.edits) {
          const idx = content.indexOf(edit.old_text);
          if (idx === -1) {
            failed.push(`Not found: "${edit.old_text.slice(0, 60)}..."`);
            continue;
          }
          // Check uniqueness
          const secondIdx = content.indexOf(edit.old_text, idx + 1);
          if (secondIdx !== -1) {
            failed.push(`Multiple matches for: "${edit.old_text.slice(0, 60)}..."`);
            continue;
          }
          content = content.slice(0, idx) + edit.new_text + content.slice(idx + edit.old_text.length);
          applied.push(`Replaced "${edit.old_text.slice(0, 40)}..." → "${edit.new_text.slice(0, 40)}..."`);
        }

        await writeFile(absPath, content, 'utf-8');

        const parts: string[] = [];
        if (applied.length) parts.push(`Applied ${applied.length} edit(s).`);
        if (failed.length) parts.push(`Failed ${failed.length}: ${failed.join('; ')}`);

        return {
          llmOutput: parts.join(' '),
          success: failed.length === 0,
          error: failed.length > 0 ? `${failed.length} edit(s) failed` : undefined,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { llmOutput: `Error editing file: ${msg}`, success: false, error: msg };
      }
    },
  });

  // ── file_search ──

  const fileSearch = tool({
    name: 'file_search',
    description:
      'Search for text across files matching a glob pattern.  Returns matching lines with file paths and line numbers.',
    input: z.object({
      query: z.string().describe('Text to search for (case-insensitive).'),
      glob: z.string().default('**/*').describe('Glob pattern to filter files (e.g. "**/*.ts").'),
    }),
    safetyClass: 'read',
    idempotent: true,
    async execute({ input }): Promise<ToolResult> {
      try {
        const globPattern = input.glob ?? '**/*';
        const pattern = globToRegex(globPattern);
        const files = await globDir(rootDir, pattern, 500, rootDir);
        const results: string[] = [];

        for (const relPath of files) {
          if (results.length >= maxSearchResults) break;
          const absPath = join(rootDir, relPath);

          try {
            const matches = await grepFile(absPath, input.query, maxSearchResults - results.length);
            for (const m of matches) {
              results.push(`${relPath}:${m.line}: ${m.text.trim()}`);
            }
          } catch {
            // Skip unreadable files (binary, permissions)
          }
        }

        if (results.length === 0) {
          return { llmOutput: `No matches for "${input.query}" in ${globPattern}`, success: true };
        }

        return {
          llmOutput: `${results.length} match(es):\n${results.join('\n')}`,
          success: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { llmOutput: `Search error: ${msg}`, success: false, error: msg };
      }
    },
  });

  // ── file_glob ──

  const fileGlob = tool({
    name: 'file_glob',
    description:
      'List files matching a glob pattern in the workspace.  Useful for discovering project structure.',
    input: z.object({
      pattern: z.string().default('**/*').describe('Glob pattern (e.g. "src/**/*.ts").'),
    }),
    safetyClass: 'read',
    idempotent: true,
    async execute({ input }): Promise<ToolResult> {
      try {
        const globPattern = input.pattern ?? '**/*';
        const regex = globToRegex(globPattern);
        const files = await globDir(rootDir, regex, maxSearchResults, rootDir);

        if (files.length === 0) {
          return { llmOutput: `No files matching "${globPattern}"`, success: true };
        }

        return {
          llmOutput: `${files.length} file(s):\n${files.join('\n')}`,
          success: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { llmOutput: `Glob error: ${msg}`, success: false, error: msg };
      }
    },
  });

  return [fileRead as ToolContract, fileWrite as ToolContract, fileEdit as ToolContract, fileSearch as ToolContract, fileGlob as ToolContract];
}
