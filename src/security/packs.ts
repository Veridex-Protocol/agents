/**
 * @packageDocumentation
 * @module SecurityPolicyPacks
 * @description
 * Built-in security policy packs that compose SDK-level detection
 * primitives into runtime-level PolicyRules and RuntimeHooks.
 *
 * Each factory returns a SecurityPolicyPack that can be registered
 * with the SecurityPolicyPackManager.
 */

import type { PolicyRule, PolicyContext } from '../policy/PolicyEngine';
import type { PolicyCheckResult } from '../types/policy';
import type { RuntimeHook, HookResult, ToolHookContext } from '../types/hooks';
import type {
  SecurityPolicyPack,
  InjectionDetectionPackOptions,
  ToolPoisoningPackOptions,
  HandoffSafetyPackOptions,
  ModelRestrictionPackOptions,
  BudgetCeilingPackOptions,
  EndpointAllowlistPackOptions,
} from './types';

// ── Helpers ──

function passResult(ruleId: string, ruleName: string, reason: string): PolicyCheckResult {
  return { ruleId, ruleName, passed: true, verdict: 'pass', reason, riskContribution: 0 };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Injection Detection Pack
// ══════════════════════════════════════════════════════════════════════════════

/** Default injection patterns for the runtime-level detector. */
const RUNTIME_INJECTION_PATTERNS: Array<{
  category: string;
  pattern: RegExp;
  severity: 'critical' | 'high' | 'medium';
  description: string;
}> = [
  // Imperative overrides
  { category: 'imperative_override', pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions/i, severity: 'critical', description: 'Imperative override' },
  { category: 'imperative_override', pattern: /disregard\s+(?:all\s+)?(?:above|previous|prior|system|earlier)/i, severity: 'critical', description: 'Disregard directive' },
  { category: 'imperative_override', pattern: /forget\s+(?:all\s+)?(?:rules|instructions|constraints|guidelines|policies)/i, severity: 'critical', description: 'Instruction erasure' },
  // Role manipulation
  { category: 'role_manipulation', pattern: /you\s+are\s+now\s+(?:a\s+)?/i, severity: 'high', description: 'Identity reassignment' },
  { category: 'role_manipulation', pattern: /pretend\s+(?:you(?:'re|\s+are)\s+)/i, severity: 'high', description: 'Role pretending' },
  { category: 'role_manipulation', pattern: /act\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:a\s+)?(?:different|new|unrestricted)/i, severity: 'high', description: 'Unrestricted role' },
  // Secret instructions
  { category: 'secret_instruction', pattern: /\[SYSTEM\]/i, severity: 'critical', description: 'System tag injection' },
  { category: 'secret_instruction', pattern: /\bhidden\b.*\b(?:command|directive|instruction)\b/i, severity: 'high', description: 'Hidden directive' },
  // Output manipulation
  { category: 'output_manipulation', pattern: /do\s+not\s+(?:mention|reveal|show|display|report)\s+this/i, severity: 'high', description: 'Output suppression' },
  // Financial imperatives
  { category: 'financial_imperative', pattern: /(?:route|send|transfer|forward)\s+(?:all\s+)?(?:funds|tokens|money|balance|assets)\s+to\s+(?:0x[a-fA-F0-9]{4,}|[a-zA-Z0-9]+\.eth)/i, severity: 'critical', description: 'Financial routing injection' },
  { category: 'financial_imperative', pattern: /(?:approve|authorize)\s+(?:unlimited|max|maximum)\s+(?:spending|allowance|amount)/i, severity: 'critical', description: 'Unlimited approval' },
  // MCP poisoning
  { category: 'mcp_poisoning', pattern: /<IMPORTANT>/i, severity: 'critical', description: 'MCP tool poisoning tag' },
  { category: 'mcp_poisoning', pattern: /<!--[\s\S]*?(?:instruction|override|ignore|secret)[\s\S]*?-->/i, severity: 'high', description: 'Hidden HTML-comment instruction' },
  // Encoding attacks
  { category: 'encoding_attack', pattern: /[\u200B\u200C\u200D\uFEFF\u00AD]/, severity: 'medium', description: 'Zero-width character' },
];

interface InjectionMatch {
  category: string;
  description: string;
  severity: 'critical' | 'high' | 'medium';
  match: string;
}

/** Scan text for injection patterns and return matches. */
function scanForInjections(
  input: string,
  patterns: typeof RUNTIME_INJECTION_PATTERNS,
): InjectionMatch[] {
  const matches: InjectionMatch[] = [];
  for (const def of patterns) {
    const m = def.pattern.exec(input);
    if (m) {
      matches.push({
        category: def.category,
        description: def.description,
        severity: def.severity,
        match: m[0],
      });
    }
  }
  return matches;
}

/** Compute risk score from injection matches. */
function computeInjectionRisk(matches: InjectionMatch[]): number {
  if (matches.length === 0) return 0;
  const weights: Record<string, number> = { critical: 0.4, high: 0.25, medium: 0.1 };
  let score = 0;
  for (const m of matches) {
    score += weights[m.severity] ?? 0.1;
  }
  return Math.min(score, 1.0);
}

/**
 * Creates an injection detection security pack.
 *
 * Provides a PolicyRule that scans proposal metadata for injection patterns,
 * and a beforeModelCall hook that scans the input prompt.
 */
export function injectionDetectionPack(opts?: InjectionDetectionPackOptions): SecurityPolicyPack {
  const escalateThreshold = opts?.escalateThreshold ?? 0.5;
  const blockThreshold = opts?.blockThreshold ?? 0.8;
  const allPatterns = [
    ...RUNTIME_INJECTION_PATTERNS,
    ...(opts?.customPatterns ?? []),
  ];

  const ruleId = 'security:injection-detection';
  const ruleName = 'Injection Detection';

  const rule: PolicyRule = {
    id: ruleId,
    name: ruleName,
    description: 'Scans proposals for prompt injection patterns',
    priority: 10,
    evaluate(ctx: PolicyContext): PolicyCheckResult {
      const inputs: string[] = [];
      if (ctx.proposal.type === 'tool_call') {
        for (const tc of ctx.proposal.toolCalls) {
          inputs.push(JSON.stringify(tc.arguments));
        }
      }
      if (ctx.metadata) {
        const prompt = ctx.metadata['prompt'] as string | undefined;
        if (prompt) inputs.push(prompt);
        const llmOutput = ctx.metadata['llmOutput'] as string | undefined;
        if (llmOutput) inputs.push(llmOutput);
      }
      if (inputs.length === 0) {
        return passResult(ruleId, ruleName, 'No scannable content');
      }
      const allMatches: InjectionMatch[] = [];
      for (const input of inputs) {
        allMatches.push(...scanForInjections(input, allPatterns));
      }
      if (allMatches.length === 0) {
        return passResult(ruleId, ruleName, `Scanned ${inputs.length} inputs — clean`);
      }
      const risk = computeInjectionRisk(allMatches);
      const criticalCount = allMatches.filter((m) => m.severity === 'critical').length;
      let verdict: 'block' | 'escalate' | 'flag' = 'flag';
      if (risk >= blockThreshold || criticalCount > 0) {
        verdict = 'block';
      } else if (risk >= escalateThreshold) {
        verdict = 'escalate';
      }
      return {
        ruleId,
        ruleName,
        passed: false,
        verdict,
        reason: `Detected ${allMatches.length} injection(s): ${allMatches.map((m) => m.description).join(', ')}`,
        riskContribution: risk,
      };
    },
  };

  const hook: RuntimeHook = {
    name: 'security:injection-beforeModelCall',
    phase: 'beforeModelCall',
    priority: 5,
    execute(ctx: unknown): HookResult | void {
      const hookCtx = ctx as { input?: string; prompt?: string };
      const text = hookCtx.input ?? hookCtx.prompt ?? '';
      if (!text) return;

      const matches = scanForInjections(text, allPatterns);
      if (matches.length === 0) return;

      const risk = computeInjectionRisk(matches);
      const criticalCount = matches.filter((m) => m.severity === 'critical').length;

      if (risk >= blockThreshold || criticalCount > 0) {
        return {
          override: 'deny',
          reason: `Injection detected in prompt: ${matches.map((m) => m.description).join(', ')}`,
          annotations: { injectionMatches: matches, injectionRisk: risk },
        };
      }
      if (risk >= escalateThreshold) {
        return {
          override: 'pause',
          reason: `Possible injection in prompt (risk: ${risk.toFixed(2)}): ${matches.map((m) => m.description).join(', ')}`,
          annotations: { injectionMatches: matches, injectionRisk: risk },
        };
      }
      return {
        annotations: { injectionMatches: matches, injectionRisk: risk },
      };
    },
  };

  return {
    id: 'security:injection-detection',
    name: 'Injection Detection',
    description: 'Detects and blocks prompt injection attacks across tool inputs, model prompts, and LLM outputs',
    version: '1.0.0',
    rules: [rule],
    hooks: [hook],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. Tool Poisoning Pack
// ══════════════════════════════════════════════════════════════════════════════

/** Patterns stripped from tool descriptions. */
const STRIP_PATTERNS: RegExp[] = [
  /<IMPORTANT>[\s\S]*?<\/IMPORTANT>/gi,
  /<HIDDEN>[\s\S]*?<\/HIDDEN>/gi,
  /<SECRET>[\s\S]*?<\/SECRET>/gi,
  /<!--[\s\S]*?(?:override|ignore|instruction|secret|important|hidden)[\s\S]*?-->/gi,
  /[\u200B\u200C\u200D\uFEFF\u00AD]+/g,
  /[\u202A-\u202E\u2066-\u2069]+/g,
];

/** Strip hidden content from a tool description. Returns [sanitized, strippedItems]. */
function sanitizeDescription(description: string): [string, string[]] {
  let result = description;
  const stripped: string[] = [];
  for (const pattern of STRIP_PATTERNS) {
    const matches = result.match(pattern);
    if (matches) stripped.push(...matches);
    result = result.replace(pattern, '');
  }
  result = result.replace(/\n{3,}/g, '\n\n').trim();
  return [result, stripped];
}

/**
 * Creates a tool poisoning defense pack.
 *
 * Provides a beforeToolValidation hook that sanitizes tool descriptions
 * and a beforeToolExecute hook that checks against pinned descriptions.
 */
export function toolPoisoningPack(opts?: ToolPoisoningPackOptions): SecurityPolicyPack {
  const autoSanitize = opts?.autoSanitize ?? true;
  const blockOnPinViolation = opts?.blockOnPinViolation ?? true;

  /** In-memory pin store for tool description hashes. */
  const pins = new Map<string, { hash: string; pinnedAt: number }>();

  /** Simple deterministic hash (FNV-1a 32-bit — no ethers dependency). */
  function fnv1aHash(str: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  const validationHook: RuntimeHook = {
    name: 'security:tool-poisoning-validation',
    phase: 'beforeToolValidation',
    priority: 5,
    execute(ctx: unknown): HookResult | void {
      if (!autoSanitize) return;
      const hookCtx = ctx as { toolName?: string; toolDescription?: string };
      if (!hookCtx.toolDescription) return;

      const [sanitized, stripped] = sanitizeDescription(hookCtx.toolDescription);
      if (stripped.length > 0) {
        return {
          annotations: {
            toolSanitized: true,
            strippedContent: stripped,
            sanitizedDescription: sanitized,
          },
        };
      }
    },
  };

  const executeHook: RuntimeHook = {
    name: 'security:tool-poisoning-pincheck',
    phase: 'beforeToolExecute',
    priority: 5,
    execute(ctx: unknown): HookResult | void {
      const hookCtx = ctx as ToolHookContext & { toolDescription?: string };
      const toolName = hookCtx.toolName;
      const description = hookCtx.toolDescription;
      if (!toolName || !description) return;

      const currentHash = fnv1aHash(description);
      const existing = pins.get(toolName);

      if (!existing) {
        // First-use pin
        pins.set(toolName, { hash: currentHash, pinnedAt: Date.now() });
        return {
          annotations: { toolPinned: true, toolName },
        };
      }

      if (existing.hash !== currentHash) {
        if (blockOnPinViolation) {
          return {
            override: 'deny',
            reason: `Tool '${toolName}' description changed since pinning — possible rug pull`,
            annotations: { toolPinViolation: true, toolName, previousHash: existing.hash, currentHash },
          };
        }
        return {
          override: 'pause',
          reason: `Tool '${toolName}' description changed — review required`,
          annotations: { toolPinViolation: true, toolName },
        };
      }
    },
  };

  return {
    id: 'security:tool-poisoning',
    name: 'Tool Poisoning Defense',
    description: 'Sanitizes tool descriptions to strip hidden instructions and detects description rug-pulls via pinning',
    version: '1.0.0',
    rules: [],
    hooks: [validationHook, executeHook],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. Handoff Safety Pack
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a handoff safety pack.
 *
 * Enforces allowlist/blocklist on handoff targets and optionally
 * requires approval for all handoffs.
 */
export function handoffSafetyPack(opts?: HandoffSafetyPackOptions): SecurityPolicyPack {
  const allowedTargets = opts?.allowedTargets ? new Set(opts.allowedTargets) : null;
  const blockedTargets = new Set(opts?.blockedTargets ?? []);
  const requireApproval = opts?.requireApproval ?? false;

  const ruleId = 'security:handoff-safety';
  const ruleName = 'Handoff Safety';

  const rule: PolicyRule = {
    id: ruleId,
    name: ruleName,
    description: 'Validates handoff targets against allow/block lists',
    priority: 15,
    evaluate(ctx: PolicyContext): PolicyCheckResult {
      if (ctx.proposal.type !== 'handoff') {
        return passResult(ruleId, ruleName, 'Not a handoff');
      }
      const target = ctx.proposal.targetAgentId;

      // Blocklist takes precedence
      if (blockedTargets.has(target)) {
        return {
          ruleId,
          ruleName,
          passed: false,
          verdict: 'block',
          reason: `Handoff target '${target}' is blocked`,
          riskContribution: 1.0,
        };
      }

      // Allowlist check
      if (allowedTargets && !allowedTargets.has(target)) {
        return {
          ruleId,
          ruleName,
          passed: false,
          verdict: 'block',
          reason: `Handoff target '${target}' is not in the allowed list`,
          riskContribution: 0.9,
        };
      }

      // Approval requirement
      if (requireApproval) {
        return {
          ruleId,
          ruleName,
          passed: false,
          verdict: 'escalate',
          reason: `Handoff to '${target}' requires approval`,
          riskContribution: 0.5,
        };
      }

      return passResult(ruleId, ruleName, `Handoff to '${target}' allowed`);
    },
  };

  const hook: RuntimeHook = {
    name: 'security:handoff-safety-hook',
    phase: 'beforeHandoff',
    priority: 10,
    execute(ctx: unknown): HookResult | void {
      const hookCtx = ctx as { targetAgentId?: string };
      const target = hookCtx.targetAgentId;
      if (!target) return;

      if (blockedTargets.has(target)) {
        return {
          override: 'deny',
          reason: `Handoff to blocked agent '${target}'`,
        };
      }
      if (allowedTargets && !allowedTargets.has(target)) {
        return {
          override: 'deny',
          reason: `Handoff to unlisted agent '${target}'`,
        };
      }
      if (requireApproval) {
        return {
          override: 'pause',
          reason: `Handoff to '${target}' requires approval`,
        };
      }
    },
  };

  return {
    id: 'security:handoff-safety',
    name: 'Handoff Safety',
    description: 'Enforce allowlist/blocklist on handoff targets with optional approval requirement',
    version: '1.0.0',
    rules: [rule],
    hooks: [hook],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. Model Restriction Pack
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a model restriction pack.
 *
 * Restricts which models and providers can be used.
 */
export function modelRestrictionPack(opts?: ModelRestrictionPackOptions): SecurityPolicyPack {
  const allowedModels = opts?.allowedModels ? new Set(opts.allowedModels.map(m => m.toLowerCase())) : null;
  const allowedProviders = opts?.allowedProviders ? new Set(opts.allowedProviders.map(p => p.toLowerCase())) : null;
  const blockUnknown = opts?.blockUnknown ?? true;

  const hook: RuntimeHook = {
    name: 'security:model-restriction-hook',
    phase: 'beforeModelCall',
    priority: 10,
    execute(ctx: unknown): HookResult | void {
      const hookCtx = ctx as { model?: string; provider?: string };
      const model = hookCtx.model?.toLowerCase();
      const provider = hookCtx.provider?.toLowerCase();

      // Check provider restriction
      if (allowedProviders && provider) {
        if (!allowedProviders.has(provider)) {
          return {
            override: 'deny',
            reason: `Provider '${provider}' is not in the allowed list`,
            annotations: { blockedProvider: provider },
          };
        }
      } else if (allowedProviders && !provider && blockUnknown) {
        return {
          override: 'deny',
          reason: 'Unknown provider — blocked by model restriction policy',
        };
      }

      // Check model restriction
      if (allowedModels && model) {
        if (!allowedModels.has(model)) {
          return {
            override: 'deny',
            reason: `Model '${model}' is not in the allowed list`,
            annotations: { blockedModel: model },
          };
        }
      } else if (allowedModels && !model && blockUnknown) {
        return {
          override: 'deny',
          reason: 'Unknown model — blocked by model restriction policy',
        };
      }
    },
  };

  return {
    id: 'security:model-restriction',
    name: 'Model Restriction',
    description: 'Restricts which LLM models and providers can be invoked',
    version: '1.0.0',
    rules: [],
    hooks: [hook],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. Budget Ceiling Pack
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a budget ceiling pack.
 *
 * Enforces per-run spend and token limits via policy rules.
 */
export function budgetCeilingPack(opts?: BudgetCeilingPackOptions): SecurityPolicyPack {
  const maxSpend = opts?.maxRunSpendUSD;
  const maxTokens = opts?.maxTokenBudget;
  const flagPercent = opts?.flagThresholdPercent ?? 80;

  const rules: PolicyRule[] = [];

  if (maxSpend !== undefined) {
    const flagThreshold = maxSpend * (flagPercent / 100);
    rules.push({
      id: 'security:budget-spend-limit',
      name: 'Budget Spend Limit',
      description: `Enforce max run spend of $${maxSpend}`,
      priority: 20,
      evaluate(ctx: PolicyContext): PolicyCheckResult {
        const spent = ctx.runSpendUSD ?? 0;
        if (spent > maxSpend) {
          return {
            ruleId: this.id,
            ruleName: this.name,
            passed: false,
            verdict: 'block',
            reason: `Run spend $${spent.toFixed(4)} exceeds limit $${maxSpend}`,
            riskContribution: 1.0,
          };
        }
        if (spent > flagThreshold) {
          return {
            ruleId: this.id,
            ruleName: this.name,
            passed: false,
            verdict: 'flag',
            reason: `Run spend $${spent.toFixed(4)} exceeds ${flagPercent}% of limit $${maxSpend}`,
            riskContribution: 0.4,
          };
        }
        return passResult('security:budget-spend-limit', 'Budget Spend Limit', `Spend $${spent.toFixed(4)} within limit`);
      },
    });
  }

  if (maxTokens !== undefined) {
    rules.push({
      id: 'security:budget-token-limit',
      name: 'Budget Token Limit',
      description: `Enforce max token budget of ${maxTokens}`,
      priority: 20,
      evaluate(ctx: PolicyContext): PolicyCheckResult {
        const tokens = ctx.totalTokens ?? 0;
        if (tokens > maxTokens) {
          return {
            ruleId: this.id,
            ruleName: this.name,
            passed: false,
            verdict: 'block',
            reason: `Token usage ${tokens} exceeds budget ${maxTokens}`,
            riskContribution: 0.9,
          };
        }
        return passResult('security:budget-token-limit', 'Budget Token Limit', `Tokens ${tokens} within budget`);
      },
    });
  }

  return {
    id: 'security:budget-ceiling',
    name: 'Budget Ceiling',
    description: 'Enforces per-run USD spend and token limits',
    version: '1.0.0',
    rules,
    hooks: [],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. Endpoint Allowlist Pack
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Convert a simple glob pattern (with * wildcards) to a RegExp.
 * Only supports * as wildcard (matches any sequence, including empty).
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${withWildcards}$`, 'i');
}

/**
 * Creates an endpoint allowlist pack.
 *
 * Validates remote endpoints (tool URLs, MCP server URLs) against
 * allow/block patterns before tool execution.
 */
export function endpointAllowlistPack(opts: EndpointAllowlistPackOptions): SecurityPolicyPack {
  const allowPatterns = opts.allowedEndpoints.map(globToRegex);
  const blockPatterns = (opts.blockedEndpoints ?? []).map(globToRegex);

  const ruleId = 'security:endpoint-allowlist';
  const ruleName = 'Endpoint Allowlist';

  const rule: PolicyRule = {
    id: ruleId,
    name: ruleName,
    description: `Allow only endpoints matching: ${opts.allowedEndpoints.join(', ')}`,
    priority: 10,
    evaluate(ctx: PolicyContext): PolicyCheckResult {
      if (ctx.proposal.type !== 'tool_call') {
        return passResult(ruleId, ruleName, 'Not a tool call');
      }
      for (const tc of ctx.proposal.toolCalls) {
        const endpoint = tc.arguments.endpoint as string | undefined
          ?? tc.arguments.url as string | undefined;
        if (!endpoint) continue;

        // Block list takes precedence
        if (blockPatterns.some((p) => p.test(endpoint))) {
          return {
            ruleId,
            ruleName,
            passed: false,
            verdict: 'block',
            reason: `Endpoint '${endpoint}' is blocked`,
            riskContribution: 1.0,
          };
        }

        // Allow list
        if (!allowPatterns.some((p) => p.test(endpoint))) {
          return {
            ruleId,
            ruleName,
            passed: false,
            verdict: 'block',
            reason: `Endpoint '${endpoint}' is not in the allowed list`,
            riskContribution: 0.9,
          };
        }
      }
      return passResult(ruleId, ruleName, 'All endpoints allowed');
    },
  };

  const hook: RuntimeHook = {
    name: 'security:endpoint-allowlist-hook',
    phase: 'beforeToolExecute',
    priority: 10,
    execute(ctx: unknown): HookResult | void {
      const hookCtx = ctx as ToolHookContext;
      const endpoint = hookCtx.toolInput?.endpoint as string | undefined
        ?? hookCtx.toolInput?.url as string | undefined;
      if (!endpoint) return;

      if (blockPatterns.some((p) => p.test(endpoint))) {
        return {
          override: 'deny',
          reason: `Endpoint '${endpoint}' is blocked`,
          annotations: { blockedEndpoint: endpoint },
        };
      }
      if (!allowPatterns.some((p) => p.test(endpoint))) {
        return {
          override: 'deny',
          reason: `Endpoint '${endpoint}' is not in the allowed list`,
          annotations: { blockedEndpoint: endpoint },
        };
      }
    },
  };

  return {
    id: 'security:endpoint-allowlist',
    name: 'Endpoint Allowlist',
    description: 'Validates remote endpoints against allow/block patterns',
    version: '1.0.0',
    rules: [rule],
    hooks: [hook],
  };
}
