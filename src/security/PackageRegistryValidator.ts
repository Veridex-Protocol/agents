/**
 * @packageDocumentation
 * @module PackageRegistryValidator
 * @description
 * Runtime package-name validator that defends against AC-1.a
 * (dependency-targeted injection) from "Your Agent Is Mine".
 *
 * Features:
 * 1. Per-ecosystem known-good package allowlists
 * 2. Levenshtein-based typosquat detection against popular packages
 * 3. Suspicious name heuristics (long random suffixes, scope squatting)
 * 4. Runtime integration with SupplyChainGuard for tool-call-time validation
 */

// ── Types ──

export interface PackageValidationResult {
  valid: boolean;
  package: string;
  manager: string;
  issues: PackageIssue[];
}

export interface PackageIssue {
  type: 'typosquat' | 'unknown' | 'suspicious_name' | 'scope_squatting';
  severity: 'critical' | 'high' | 'medium';
  description: string;
  evidence?: Record<string, unknown>;
}

export interface PackageRegistryConfig {
  /** Known-good packages per ecosystem. Keys: 'npm', 'pip', 'cargo', etc. */
  allowlists?: Record<string, string[]>;
  /** Max Levenshtein distance for typosquat flagging (default: 2). */
  typosquatThreshold?: number;
  /** Whether to block unknown packages (not in allowlist) or just flag (default: 'flag'). */
  unknownPackagePolicy?: 'block' | 'flag' | 'allow';
}

// ── Popular package registries for typosquat detection ──

const POPULAR_NPM: string[] = [
  'express', 'react', 'react-dom', 'vue', 'angular', 'next', 'nuxt',
  'axios', 'lodash', 'underscore', 'moment', 'dayjs', 'date-fns',
  'typescript', 'webpack', 'vite', 'rollup', 'esbuild', 'tsup',
  'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'chai',
  'zod', 'joi', 'yup', 'prisma', 'drizzle-orm', 'typeorm', 'sequelize',
  'tailwindcss', 'postcss', 'autoprefixer', 'sass', 'less',
  'ethers', 'web3', 'viem', 'wagmi', 'hardhat', 'foundry',
  'openai', 'anthropic', 'langchain', '@langchain/core',
  'hono', 'fastify', 'koa', 'socket.io', 'ws',
  'mongoose', 'pg', 'mysql2', 'ioredis', 'redis',
  'dotenv', 'chalk', 'commander', 'inquirer', 'ora',
  'jsonwebtoken', 'bcrypt', 'bcryptjs', 'argon2',
  'uuid', 'nanoid', 'crypto-js', 'node-forge',
  'sharp', 'multer', 'formidable',
  'puppeteer', 'playwright', 'cheerio',
  'nodemailer', 'rate-limiter-flexible', 'helmet',
  'cors', 'cookie-parser', 'body-parser', 'compression',
];

const POPULAR_PIP: string[] = [
  'requests', 'flask', 'django', 'fastapi', 'uvicorn', 'gunicorn',
  'numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn', 'plotly',
  'tensorflow', 'pytorch', 'torch', 'transformers', 'huggingface-hub',
  'scikit-learn', 'xgboost', 'lightgbm', 'catboost',
  'pyyaml', 'pydantic', 'sqlalchemy', 'alembic',
  'celery', 'redis', 'boto3', 'botocore',
  'pillow', 'opencv-python', 'imageio',
  'cryptography', 'paramiko', 'fabric',
  'beautifulsoup4', 'scrapy', 'selenium', 'playwright',
  'pytest', 'black', 'mypy', 'ruff', 'flake8', 'isort',
  'httpx', 'aiohttp', 'starlette', 'click', 'typer', 'rich',
  'openai', 'anthropic', 'langchain', 'llama-index',
  'web3', 'eth-account', 'eth-brownie',
  'docker', 'kubernetes', 'psutil', 'watchdog',
];

const POPULAR_CARGO: string[] = [
  'serde', 'serde_json', 'tokio', 'async-std', 'reqwest', 'hyper',
  'clap', 'structopt', 'rand', 'regex', 'chrono', 'log', 'env_logger',
  'actix-web', 'axum', 'rocket', 'warp',
  'sqlx', 'diesel', 'sea-orm',
  'thiserror', 'anyhow', 'color-eyre',
  'tracing', 'tracing-subscriber',
  'sled', 'rusqlite',
  'ethers', 'alloy', 'foundry',
];

const ECOSYSTEM_POPULAR: Record<string, string[]> = {
  npm: POPULAR_NPM,
  yarn: POPULAR_NPM,
  pnpm: POPULAR_NPM,
  pip: POPULAR_PIP,
  cargo: POPULAR_CARGO,
};

// ── Levenshtein ──

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
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[la][lb];
}

// ── Suspicious name heuristics ──

const SUSPICIOUS_PATTERNS = [
  /** Random hex suffix (e.g., 'requests-2f4a8b') */
  /^.+-[a-f0-9]{6,}$/i,
  /** Excessively long name (>50 chars) */
  /^.{50,}$/,
  /** Multiple consecutive hyphens */
  /---+/,
  /** Name ending with numbers that don't look like versions */
  /^[a-z]+-\d{4,}$/i,
];

/** npm scope squatting: @attacker-scope/popular-package */
const SCOPE_SQUAT_PATTERN = /^@([^/]+)\/(.+)$/;

// ── Validator Class ──

export class PackageRegistryValidator {
  private readonly allowlists: Record<string, Set<string>>;
  private readonly typosquatThreshold: number;
  private readonly unknownPolicy: 'block' | 'flag' | 'allow';

  constructor(config?: PackageRegistryConfig) {
    this.typosquatThreshold = config?.typosquatThreshold ?? 2;
    this.unknownPolicy = config?.unknownPackagePolicy ?? 'flag';

    this.allowlists = {};
    if (config?.allowlists) {
      for (const [ecosystem, packages] of Object.entries(config.allowlists)) {
        this.allowlists[ecosystem] = new Set(packages.map((p) => p.toLowerCase()));
      }
    }
  }

  /**
   * Validate a package name before allowing installation.
   */
  validate(packageName: string, manager: string): PackageValidationResult {
    const issues: PackageIssue[] = [];
    const normalized = packageName.toLowerCase();
    const ecosystem = manager.toLowerCase();

    // 1. Check allowlist if configured
    const allowlist = this.allowlists[ecosystem];
    if (allowlist && !allowlist.has(normalized)) {
      if (this.unknownPolicy === 'block') {
        issues.push({
          type: 'unknown',
          severity: 'high',
          description: `Package '${packageName}' is not in the ${ecosystem} allowlist`,
        });
      } else if (this.unknownPolicy === 'flag') {
        issues.push({
          type: 'unknown',
          severity: 'medium',
          description: `Package '${packageName}' is not in the ${ecosystem} allowlist — flagged for review`,
        });
      }
    }

    // 2. Typosquat detection against popular packages
    const popularList = ECOSYSTEM_POPULAR[ecosystem] ?? [];
    for (const popular of popularList) {
      if (normalized === popular) break; // Exact match — legit
      const dist = levenshtein(normalized, popular);
      if (dist > 0 && dist <= this.typosquatThreshold) {
        issues.push({
          type: 'typosquat',
          severity: 'critical',
          description: `'${packageName}' is ${dist} edit(s) from popular package '${popular}' — likely typosquat`,
          evidence: { popular, levenshteinDistance: dist },
        });
        break; // One typosquat finding is enough
      }
    }

    // 3. Suspicious name heuristics
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(packageName)) {
        issues.push({
          type: 'suspicious_name',
          severity: 'high',
          description: `Package name '${packageName}' matches suspicious pattern: ${pattern.source}`,
          evidence: { pattern: pattern.source },
        });
        break;
      }
    }

    // 4. Scope squatting for npm-like managers
    if (['npm', 'yarn', 'pnpm'].includes(ecosystem)) {
      const scopeMatch = SCOPE_SQUAT_PATTERN.exec(packageName);
      if (scopeMatch) {
        const [, scope, name] = scopeMatch;
        // Check if the unscoped name is a popular package
        const isPopular = popularList.includes(name.toLowerCase());
        // Known legitimate scopes
        const trustedScopes = new Set([
          'types', 'babel', 'eslint', 'jest', 'testing-library',
          'angular', 'vue', 'svelte', 'astro', 'nuxt',
          'aws-sdk', 'google-cloud', 'azure',
          'prisma', 'trpc', 'tanstack', 'radix-ui', 'shadcn',
          'langchain', 'veridex', 'openzeppelin',
        ]);
        if (isPopular && !trustedScopes.has(scope.toLowerCase())) {
          issues.push({
            type: 'scope_squatting',
            severity: 'high',
            description: `'${packageName}' appears to be scope-squatting popular package '${name}' under unknown scope '@${scope}'`,
            evidence: { scope, unscoped: name },
          });
        }
      }
    }

    return {
      valid: issues.filter((i) => i.severity === 'critical' || i.severity === 'high').length === 0,
      package: packageName,
      manager,
      issues,
    };
  }

  /**
   * Validate multiple packages at once.
   */
  validateBatch(packages: Array<{ name: string; manager: string }>): PackageValidationResult[] {
    return packages.map(({ name, manager }) => this.validate(name, manager));
  }
}
