/**
 * @packageDocumentation
 * @module ShellInstallPolicyGate
 * @description
 * Fail-closed policy gate for shell-execution and package-install tool calls.
 *
 * Addresses AC-1 (payload injection) and AC-1.a (dependency-targeted injection)
 * from "Your Agent Is Mine" (Shou et al., 2026).
 *
 * The gate:
 * 1. Detects shell-execution tools (Bash, run_command, execute, shell, terminal)
 * 2. Parses commands for URL-fetching patterns (curl, wget, fetch)
 * 3. Validates URLs against a domain allowlist — blocks non-allowlisted domains
 * 4. Detects package-install commands (pip, npm, yarn, pnpm, cargo, gem, go)
 * 5. Validates package names against an allowlist — blocks unknown packages
 * 6. Performs typosquat detection via Levenshtein distance against known-good packages
 */

import type { PolicyRule, PolicyContext } from '../policy/PolicyEngine';
import type { PolicyCheckResult } from '../types/policy';
import type { RuntimeHook, HookResult, ToolHookContext } from '../types/hooks';
import type { SecurityPolicyPack } from './types';

// ── Types ──

export interface ShellInstallGateOptions {
  /** Allowed domains for curl/wget/fetch URLs. Default: common safe domains. */
  allowedDomains?: string[];
  /** Additional blocked domains (takes precedence). */
  blockedDomains?: string[];
  /** Known-good package names. If set, unknown packages are flagged. */
  allowedPackages?: string[];
  /** Maximum Levenshtein distance to flag as potential typosquat (default: 2). */
  typosquatThreshold?: number;
  /** Popular packages to check typosquats against. Auto-populated if not set. */
  popularPackages?: string[];
  /** Block piped shell execution (curl ... | sh). Default: true. */
  blockPipedExecution?: boolean;
  /** Shell-execution tool names to gate. Defaults to common names. */
  shellToolNames?: string[];
}

// ── Shell tool name patterns ──

const DEFAULT_SHELL_TOOL_NAMES = new Set([
  'bash', 'Bash', 'shell', 'Shell', 'run_command', 'RunCommand',
  'execute', 'Execute', 'terminal', 'Terminal', 'cmd', 'Cmd',
  'run', 'Run', 'exec', 'Exec', 'sh', 'zsh',
]);

// ── URL extraction patterns ──

const URL_FETCH_PATTERNS = [
  /(?:curl|wget|fetch)\s+(?:-[^\s]*\s+)*["']?(https?:\/\/[^\s"'|>]+)/gi,
  /(?:curl|wget)\s+(?:--[a-z-]+(?:\s+[^\s]+)?\s+)*["']?(https?:\/\/[^\s"'|>]+)/gi,
];

// ── Piped execution pattern ──

const PIPED_EXECUTION = /(?:curl|wget)\s+[^|]*\|\s*(?:sh|bash|zsh|source|eval|python|node|ruby|perl)/i;

// ── Package install patterns ──

interface PackageInstallMatch {
  manager: string;
  packages: string[];
  raw: string;
}

const INSTALL_PATTERNS: Array<{
  manager: string;
  pattern: RegExp;
  packageExtractor: (match: RegExpMatchArray) => string[];
}> = [
  {
    manager: 'pip',
    pattern: /(?:pip3?|python3?\s+-m\s+pip)\s+install\s+((?:(?!-)[^\s|;&]+\s*)+)/gi,
    packageExtractor: (m) => extractPackageNames(m[1]),
  },
  {
    manager: 'npm',
    pattern: /npm\s+(?:install|i|add)\s+((?:(?!-)[^\s|;&]+\s*)+)/gi,
    packageExtractor: (m) => extractPackageNames(m[1]),
  },
  {
    manager: 'yarn',
    pattern: /yarn\s+add\s+((?:(?!-)[^\s|;&]+\s*)+)/gi,
    packageExtractor: (m) => extractPackageNames(m[1]),
  },
  {
    manager: 'pnpm',
    pattern: /pnpm\s+(?:add|install|i)\s+((?:(?!-)[^\s|;&]+\s*)+)/gi,
    packageExtractor: (m) => extractPackageNames(m[1]),
  },
  {
    manager: 'cargo',
    pattern: /cargo\s+(?:add|install)\s+((?:(?!-)[^\s|;&]+\s*)+)/gi,
    packageExtractor: (m) => extractPackageNames(m[1]),
  },
  {
    manager: 'gem',
    pattern: /gem\s+install\s+((?:(?!-)[^\s|;&]+\s*)+)/gi,
    packageExtractor: (m) => extractPackageNames(m[1]),
  },
  {
    manager: 'go',
    pattern: /go\s+(?:get|install)\s+((?:(?!-)[^\s|;&]+\s*)+)/gi,
    packageExtractor: (m) => extractPackageNames(m[1]),
  },
];

/** Extract package names from the captured group, filtering flags and paths. */
function extractPackageNames(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !s.startsWith('-'))         // skip flags
    .filter((s) => !s.startsWith('/'))         // skip absolute paths
    .filter((s) => !s.startsWith('.'))         // skip relative paths
    .filter((s) => !s.includes('://'))         // skip URLs
    .map((s) => s.replace(/[=<>!~^].*/g, '')) // strip version specifiers
    .filter((s) => s.length > 0);
}

// ── Levenshtein distance ──

function levenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  const dp: number[][] = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost, // substitution
      );
    }
  }
  return dp[la][lb];
}

// ── Popular packages (top packages across ecosystems for typosquat detection) ──

const DEFAULT_POPULAR_PACKAGES = [
  // Python
  'requests', 'flask', 'django', 'numpy', 'pandas', 'scipy', 'matplotlib',
  'tensorflow', 'pytorch', 'torch', 'transformers', 'fastapi', 'uvicorn',
  'pyyaml', 'pydantic', 'sqlalchemy', 'celery', 'redis', 'boto3', 'pillow',
  'cryptography', 'paramiko', 'beautifulsoup4', 'scrapy', 'selenium',
  'pytest', 'black', 'mypy', 'httpx', 'aiohttp',
  // Node.js
  'express', 'react', 'vue', 'angular', 'next', 'nuxt', 'axios', 'lodash',
  'typescript', 'webpack', 'vite', 'eslint', 'prettier', 'jest', 'vitest',
  'zod', 'prisma', 'drizzle-orm', 'tailwindcss', 'postcss', 'ethers',
  'web3', 'viem', 'wagmi', 'openai', 'anthropic', 'langchain',
  'hono', 'fastify', 'koa', 'socket.io', 'mongoose', 'pg', 'ioredis',
  // Rust
  'serde', 'tokio', 'reqwest', 'clap', 'async-std', 'rand', 'regex',
  'chrono', 'hyper', 'actix-web', 'axum', 'sqlx', 'diesel',
];

// ── Default safe domains ──

const DEFAULT_ALLOWED_DOMAINS = [
  'github.com', 'raw.githubusercontent.com', 'githubusercontent.com',
  'npmjs.com', 'registry.npmjs.org', 'yarnpkg.com',
  'pypi.org', 'files.pythonhosted.org',
  'crates.io', 'static.crates.io',
  'rubygems.org',
  'pkg.go.dev', 'proxy.golang.org',
  'dl.google.com', 'storage.googleapis.com',
  'deb.nodesource.com', 'apt.llvm.org',
  'get.docker.com', 'download.docker.com',
  'bun.sh', 'deno.land',
  'rust-lang.org', 'sh.rustup.rs', 'static.rust-lang.org',
  'brew.sh', 'raw.githubusercontent.com',
  'releases.hashicorp.com',
  'nodejs.org', 'get.volta.sh',
];

// ── Extract domain from URL ──

function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    const match = url.match(/https?:\/\/([^/:]+)/);
    return match ? match[1].toLowerCase() : null;
  }
}

// ── Implementation ──

export function shellInstallGatePack(opts?: ShellInstallGateOptions): SecurityPolicyPack {
  const allowedDomains = new Set(
    (opts?.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS).map((d) => d.toLowerCase()),
  );
  const blockedDomains = new Set(
    (opts?.blockedDomains ?? []).map((d) => d.toLowerCase()),
  );
  const allowedPackages = opts?.allowedPackages
    ? new Set(opts.allowedPackages.map((p) => p.toLowerCase()))
    : null;
  const typosquatThreshold = opts?.typosquatThreshold ?? 2;
  const popularPackages = (opts?.popularPackages ?? DEFAULT_POPULAR_PACKAGES)
    .map((p) => p.toLowerCase());
  const blockPipedExecution = opts?.blockPipedExecution ?? true;
  const shellToolNames = opts?.shellToolNames
    ? new Set(opts.shellToolNames)
    : DEFAULT_SHELL_TOOL_NAMES;

  /** Check if a domain is allowed. Supports subdomain matching. */
  function isDomainAllowed(domain: string): boolean {
    if (blockedDomains.has(domain)) return false;
    if (allowedDomains.has(domain)) return true;
    // Check if it's a subdomain of an allowed domain
    for (const allowed of allowedDomains) {
      if (domain.endsWith(`.${allowed}`)) return true;
    }
    return false;
  }

  /** Find potential typosquats among popular packages. */
  function findTyposquats(pkg: string): Array<{ popular: string; distance: number }> {
    const results: Array<{ popular: string; distance: number }> = [];
    const normalized = pkg.toLowerCase();
    for (const popular of popularPackages) {
      if (normalized === popular) continue; // exact match — not a typosquat
      const dist = levenshtein(normalized, popular);
      if (dist > 0 && dist <= typosquatThreshold) {
        results.push({ popular, distance: dist });
      }
    }
    return results;
  }

  /** Parse all install commands from a shell command string. */
  function parseInstallCommands(command: string): PackageInstallMatch[] {
    const results: PackageInstallMatch[] = [];
    for (const { manager, pattern, packageExtractor } of INSTALL_PATTERNS) {
      // Reset regex state
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(command)) !== null) {
        const packages = packageExtractor(match);
        if (packages.length > 0) {
          results.push({ manager, packages, raw: match[0] });
        }
      }
    }
    return results;
  }

  /** Extract URLs from a shell command string. */
  function extractUrls(command: string): string[] {
    const urls: string[] = [];
    for (const pattern of URL_FETCH_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(command)) !== null) {
        if (match[1]) urls.push(match[1]);
      }
    }
    return urls;
  }

  // ── Policy Rule ──

  const ruleId = 'security:shell-install-gate';
  const ruleName = 'Shell & Install Policy Gate';

  const rule: PolicyRule = {
    id: ruleId,
    name: ruleName,
    description: 'Fail-closed gate for shell execution and package installation commands',
    priority: 5, // High priority — runs early
    evaluate(ctx: PolicyContext): PolicyCheckResult {
      if (ctx.proposal.type !== 'tool_call') {
        return { ruleId, ruleName, passed: true, verdict: 'pass', reason: 'Not a tool call', riskContribution: 0 };
      }

      for (const tc of ctx.proposal.toolCalls) {
        if (!shellToolNames.has(tc.name)) continue;

        const command = (tc.arguments.command as string)
          ?? (tc.arguments.cmd as string)
          ?? (tc.arguments.input as string)
          ?? '';
        if (!command) continue;

        // ── Piped execution check ──
        if (blockPipedExecution && PIPED_EXECUTION.test(command)) {
          return {
            ruleId, ruleName, passed: false, verdict: 'block',
            reason: `Piped shell execution detected: command pipes remote content into interpreter`,
            riskContribution: 1.0,
          };
        }

        // ── URL domain check ──
        const urls = extractUrls(command);
        for (const url of urls) {
          const domain = extractDomain(url);
          if (domain && !isDomainAllowed(domain)) {
            return {
              ruleId, ruleName, passed: false, verdict: 'block',
              reason: `URL domain '${domain}' is not in the allowed domain list`,
              riskContribution: 0.95,
            };
          }
        }

        // ── Package install check ──
        const installs = parseInstallCommands(command);
        for (const install of installs) {
          for (const pkg of install.packages) {
            // Allowlist check
            if (allowedPackages && !allowedPackages.has(pkg.toLowerCase())) {
              return {
                ruleId, ruleName, passed: false, verdict: 'escalate',
                reason: `Package '${pkg}' (via ${install.manager}) is not in the allowed package list`,
                riskContribution: 0.8,
              };
            }

            // Typosquat detection
            const typosquats = findTyposquats(pkg);
            if (typosquats.length > 0) {
              const closest = typosquats[0];
              return {
                ruleId, ruleName, passed: false, verdict: 'block',
                reason: `Possible typosquat: '${pkg}' is ${closest.distance} edit(s) from popular package '${closest.popular}'`,
                riskContribution: 0.9,
              };
            }
          }
        }
      }

      return { ruleId, ruleName, passed: true, verdict: 'pass', reason: 'Shell commands validated', riskContribution: 0 };
    },
  };

  // ── Before-Tool-Execute Hook (double-check at execution time) ──

  const hook: RuntimeHook = {
    name: 'security:shell-install-gate-hook',
    phase: 'beforeToolExecute',
    priority: 5,
    execute(ctx: unknown): HookResult | undefined {
      const hookCtx = ctx as ToolHookContext;
      if (!hookCtx.toolName || !shellToolNames.has(hookCtx.toolName)) return;

      const command = (hookCtx.toolInput?.command as string)
        ?? (hookCtx.toolInput?.cmd as string)
        ?? (hookCtx.toolInput?.input as string)
        ?? '';
      if (!command) return;

      // Piped execution
      if (blockPipedExecution && PIPED_EXECUTION.test(command)) {
        return {
          override: 'deny',
          reason: 'Piped shell execution blocked: remote content piped to interpreter',
          annotations: { securityGate: 'shell-install', violation: 'piped_execution' },
        };
      }

      // URL check
      const urls = extractUrls(command);
      for (const url of urls) {
        const domain = extractDomain(url);
        if (domain && !isDomainAllowed(domain)) {
          return {
            override: 'deny',
            reason: `Blocked: URL domain '${domain}' not in allowed list`,
            annotations: { securityGate: 'shell-install', violation: 'url_domain', domain },
          };
        }
      }

      // Package typosquat check
      const installs = parseInstallCommands(command);
      for (const install of installs) {
        for (const pkg of install.packages) {
          const typosquats = findTyposquats(pkg);
          if (typosquats.length > 0) {
            return {
              override: 'deny',
              reason: `Blocked: '${pkg}' is a potential typosquat of '${typosquats[0].popular}'`,
              annotations: { securityGate: 'shell-install', violation: 'typosquat', package: pkg },
            };
          }
          if (allowedPackages && !allowedPackages.has(pkg.toLowerCase())) {
            return {
              override: 'pause',
              reason: `Package '${pkg}' requires approval — not in allowed list`,
              annotations: { securityGate: 'shell-install', violation: 'unknown_package', package: pkg },
            };
          }
        }
      }
    },
  };

  return {
    id: 'security:shell-install-gate',
    name: 'Shell & Install Policy Gate',
    description: 'Fail-closed gate for shell execution (URL domain allowlist) and package installation (typosquat detection, package allowlist). Addresses AC-1 and AC-1.a.',
    version: '1.0.0',
    rules: [rule],
    hooks: [hook],
  };
}
