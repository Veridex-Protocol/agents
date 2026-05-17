/**
 * @packageDocumentation
 * @module ToolDisclosureTools
 * @description
 * Progressive tool disclosure (Phase 2.6 — Root Theorem context hygiene).
 *
 * Full tool catalogs balloon the system prompt: a 20-tool catalog with
 * generous descriptions easily costs 4–8K tokens per turn. Most of
 * that is wasted — the model only needs the *summary* of each tool to
 * decide which one to invoke, then can fetch the full schema on
 * demand.
 *
 * When the runtime is constructed with `progressiveToolDisclosure: true`,
 * its tool catalog renders only `name [safetyClass] — summary` lines.
 * The model then calls `load_tool(name)` to retrieve the full
 * description, input schema, and error templates for any single tool
 * before invoking it.
 *
 * Tools without a structured `guidance.summary` fall back to the first
 * line of their description (truncated to 120 chars) so existing tool
 * libraries keep working without modification.
 */

import { z } from 'zod';
import { tool } from './tool';
import type { ToolContract } from '../types/tools';

/** Compact one-line summary for a tool in the disclosed catalog. */
export function summariseToolForCatalog(contract: ToolContract): string {
  const explicit = contract.guidance?.summary?.trim();
  if (explicit) return explicit;
  const firstLine = (contract.description ?? '').split('\n', 1)[0]?.trim() ?? '';
  if (firstLine.length <= 120) return firstLine;
  return firstLine.slice(0, 117) + '...';
}

/**
 * Render a tool catalog in **disclosed** form: one line per tool with
 * only `name [safetyClass] — summary`. Returns an empty string when no
 * tools are registered.
 */
export function renderDisclosedCatalog(
  contracts: ReadonlyArray<ToolContract>,
): string {
  if (contracts.length === 0) return '';
  const lines = contracts.map(
    (t) => `- ${t.name} [${t.safetyClass}] — ${summariseToolForCatalog(t)}`,
  );
  lines.push(
    '',
    'This catalog shows summaries only. Call `load_tool(name)` to fetch the full description, ' +
      'input schema, and error templates before invoking a tool.',
  );
  return lines.join('\n');
}

/** Render the full schema/description for a single tool. */
export function renderFullToolDetail(contract: ToolContract): string {
  const parts: string[] = [
    `Tool: ${contract.name} [${contract.safetyClass}]`,
    '',
    contract.description ?? '(no description)',
  ];
  if (contract.permissions?.length) {
    parts.push('', `Permissions: ${contract.permissions.join(', ')}`);
  }
  if (contract.timeoutMs) {
    parts.push(`Timeout: ${contract.timeoutMs}ms`);
  }
  if (contract.idempotent !== undefined) {
    parts.push(`Idempotent: ${contract.idempotent}`);
  }
  if (contract.errorTemplates?.byCode) {
    parts.push(
      '',
      'Error templates:',
      ...Object.entries(contract.errorTemplates.byCode).map(
        ([code, template]) => `  - ${code}: ${template}`,
      ),
    );
  }
  // Input schema: best-effort — JSON Schema dicts get JSON-stringified,
  // Zod schemas are described by structure (`_def.typeName`) only since
  // we don't want to pull zod-to-json-schema as a hard dep here.
  const input = contract.input as unknown;
  if (input && typeof input === 'object') {
    if ('_def' in input) {
      parts.push('', 'Input schema: Zod schema (call the tool to validate inputs).');
    } else {
      try {
        parts.push('', 'Input schema:', JSON.stringify(input, null, 2));
      } catch {
        // Ignore serialization failure; the agent can still call the tool.
      }
    }
  }
  return parts.join('\n');
}

/** Provider that the load_tool wrapper uses to find a contract by name. */
export type ToolContractLookup = (name: string) => ToolContract | undefined;

/**
 * Build the `load_tool` built-in. The runtime registers this
 * automatically when `progressiveToolDisclosure: true`.
 */
export function createLoadToolBuiltin(lookup: ToolContractLookup): ToolContract {
  const contract = tool({
    name: 'load_tool',
    guidance: {
      summary:
        'Fetch the full description, input schema, and error templates for a specific tool from the disclosed catalog.',
      whenToUse: [
        'Before invoking a tool whose details are not yet shown in the catalog.',
        'When a tool name is known but the input shape is unclear.',
      ],
      whenNotToUse: [
        'When the tool has already been loaded in a previous turn.',
        'When the tool is known to be trivial (e.g. `get_time`).',
      ],
      successExample:
        'Returns the full description, permissions, and input schema for the requested tool.',
    },
    input: z.object({
      name: z.string().min(1).describe('Exact tool name from the disclosed catalog.'),
    }),
    safetyClass: 'read',
    idempotent: true,
    async execute({ input }) {
      const contract = lookup(input.name);
      if (!contract) {
        return {
          success: false,
          llmOutput: `No tool named "${input.name}" is registered. Refer to the disclosed catalog for available names.`,
          error: 'tool_not_found',
        };
      }
      return {
        success: true,
        llmOutput: renderFullToolDetail(contract),
      };
    },
  });
  return contract as unknown as ToolContract;
}
