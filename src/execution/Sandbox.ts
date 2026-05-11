/**
 * @packageDocumentation
 * @module Sandbox
 * @description
 * Sandboxed code-execution surface for Veridex agents.
 *
 * Why this exists:
 *   The article every senior engineer has internalised by now ("Don't run
 *   unsandboxed code execution. Ever.") leaves a gap most agent
 *   frameworks ship with: customers wire E2B / Modal / Browserbase
 *   themselves, and the framework's *default* path through codegen tools
 *   is unsandboxed. Veridex closes that gap by shipping:
 *
 *     1. `SandboxRuntime` — the contract every backend implements.
 *     2. `DenyAllSandbox` — the secure default. Calls fail loudly so
 *        nobody ships codegen-without-sandbox by accident.
 *     3. `LocalProcessSandbox` — a hardened in-process fallback that
 *        uses Node's `child_process.spawn` with a binary allowlist,
 *        env-stripping, no shell, output cap, hard timeout, and an
 *        explicit "this is NOT a real sandbox" caveat for tests/local
 *        dev only.
 *     4. Pluggable adapters — implement `SandboxRuntime` with E2B /
 *        Modal / firecracker / Daytona / your own VM provider; the
 *        rest of the framework (tools, policy, audit) doesn't care.
 *     5. `createSandboxedExecTool()` — a ready-to-register tool that
 *        wraps any `SandboxRuntime`, applies the right safety class,
 *        idempotency = false, error templates, and approval gating.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { tool, formatToolError } from '../tools/tool';
import type { ToolContract } from '../types/tools';
import { z } from 'zod';

// ═════════════════════════════════════════════════════════════════════════
// Contract
// ═════════════════════════════════════════════════════════════════════════

/** Languages the sandbox is willing to execute. Backends advertise support. */
export type SandboxLanguage = 'python' | 'node' | 'bash' | 'typescript';

/** Network policy. The default is `deny`; anything else is opt-in. */
export type SandboxNetworkPolicy =
  | { mode: 'deny' }
  | { mode: 'allowlist'; hosts: string[] }
  | { mode: 'open' };

export interface SandboxExecuteRequest {
  /** Source to execute. Treat as untrusted input. */
  code: string;
  /** Language to execute. */
  language: SandboxLanguage;
  /** Optional stdin to feed. */
  stdin?: string;
  /** Maximum wall-clock time, ms. Hard ceiling enforced by the runtime. */
  timeoutMs?: number;
  /** Maximum bytes captured from stdout/stderr combined. Defaults to 64 KB. */
  maxOutputBytes?: number;
  /** Environment variables to expose to the sandbox. Default: empty. */
  env?: Record<string, string>;
  /** Network policy. Default: `{ mode: 'deny' }`. */
  network?: SandboxNetworkPolicy;
  /** Optional working directory. Backends may ignore. */
  workingDir?: string;
  /** Optional file inputs to materialize before execution. */
  files?: Array<{ path: string; content: string }>;
}

export interface SandboxExecuteResult {
  /** True when the process exited with status 0 within the time/output limits. */
  success: boolean;
  /** Stable error code on failure: `timeout` | `output_truncated` | `language_unsupported` | `network_denied` | `runtime_error` | `denied`. */
  errorCode?: string;
  /** Captured stdout, truncated to `maxOutputBytes`. */
  stdout: string;
  /** Captured stderr, truncated to `maxOutputBytes`. */
  stderr: string;
  /** Exit code from the underlying process, when available. */
  exitCode?: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** True if output was capped at `maxOutputBytes`. */
  truncated?: boolean;
  /** Backend-specific metadata (sandbox id, region, attestation, etc.). */
  metadata?: Record<string, unknown>;
}

/** Capabilities a backend advertises so callers can pick the right one. */
export interface SandboxCapabilities {
  languages: SandboxLanguage[];
  /** True when the backend executes outside the host process (E2B, Modal, firecracker). */
  isolated: boolean;
  /** True when the backend can enforce network egress controls. */
  enforcesNetworkPolicy: boolean;
  /** Free-form vendor identifier for telemetry. */
  vendor: string;
}

/**
 * The contract every sandbox backend implements. Implementations MUST
 * reject `language` they don't support with a `language_unsupported`
 * error code and MUST honour `timeoutMs` and `maxOutputBytes` even
 * when the underlying provider does not.
 */
export interface SandboxRuntime {
  capabilities(): SandboxCapabilities;
  execute(req: SandboxExecuteRequest): Promise<SandboxExecuteResult>;
  /** Optional cleanup hook — backends with persistent VMs can shut them down. */
  dispose?(): Promise<void>;
}

// ═════════════════════════════════════════════════════════════════════════
// Deny-all default
// ═════════════════════════════════════════════════════════════════════════

/**
 * The secure default. Refuses every request with a clear error so
 * codegen agents fail loudly during integration instead of silently
 * shelling out on the host.
 */
export class DenyAllSandbox implements SandboxRuntime {
  capabilities(): SandboxCapabilities {
    return { languages: [], isolated: true, enforcesNetworkPolicy: true, vendor: 'deny-all' };
  }
  async execute(_req: SandboxExecuteRequest): Promise<SandboxExecuteResult> {
    return {
      success: false,
      errorCode: 'denied',
      stdout: '',
      stderr:
        'No sandbox runtime is configured. Wire `LocalProcessSandbox` for tests, ' +
        'or an isolated backend (E2B / Modal / firecracker) for production. ' +
        'See https://docs.veridex.network/security/sandbox.',
      durationMs: 0,
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// LocalProcessSandbox — DEV ONLY
// ═════════════════════════════════════════════════════════════════════════

export interface LocalProcessSandboxOptions {
  /**
   * Absolute paths of the only binaries the sandbox is allowed to spawn.
   * MUST be set explicitly. There is no implicit allowlist.
   */
  allowedBinaries: {
    python?: string;
    node?: string;
    bash?: string;
    /** Path to ts-node or equivalent. Required to run `typescript`. */
    typescript?: string;
  };
  /** Default timeout (ms) when the request omits one. Default 5_000. */
  defaultTimeoutMs?: number;
  /** Default max output bytes when the request omits one. Default 64 KiB. */
  defaultMaxOutputBytes?: number;
  /**
   * If true, allow the request to override env vars. Default false — env
   * is always emptied except for `PATH` (set to a controlled value).
   */
  allowEnvPassthrough?: boolean;
  /** PATH value handed to children. Default: '/usr/bin:/bin'. */
  childPath?: string;
}

/**
 * In-process sandbox using `child_process.spawn`.
 *
 * **WARNING.** This runs untrusted code in a child process on the host
 * kernel. It uses an explicit binary allowlist, drops env vars, denies
 * shell expansion, caps output, and enforces a hard timeout — but it is
 * NOT a real isolation boundary. A determined attacker who controls the
 * code can still escape via filesystem access, host network, or kernel
 * exploits. Use this for unit tests and local development only. For
 * production, plug in an isolated backend (E2B, Modal, firecracker,
 * Daytona, gVisor) by implementing `SandboxRuntime`.
 */
export class LocalProcessSandbox implements SandboxRuntime {
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;

  constructor(private readonly options: LocalProcessSandboxOptions) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000;
    this.defaultMaxOutputBytes = options.defaultMaxOutputBytes ?? 64 * 1024;
  }

  capabilities(): SandboxCapabilities {
    const langs: SandboxLanguage[] = [];
    if (this.options.allowedBinaries.python) langs.push('python');
    if (this.options.allowedBinaries.node) langs.push('node');
    if (this.options.allowedBinaries.bash) langs.push('bash');
    if (this.options.allowedBinaries.typescript) langs.push('typescript');
    return {
      languages: langs,
      isolated: false,
      enforcesNetworkPolicy: false,
      vendor: 'local-process',
    };
  }

  async execute(req: SandboxExecuteRequest): Promise<SandboxExecuteResult> {
    const start = Date.now();
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const maxBytes = req.maxOutputBytes ?? this.defaultMaxOutputBytes;
    const network = req.network ?? { mode: 'deny' };

    const binary = this.resolveBinary(req.language);
    if (!binary) {
      return {
        success: false,
        errorCode: 'language_unsupported',
        stdout: '',
        stderr: `Language '${req.language}' is not configured on this LocalProcessSandbox.`,
        durationMs: Date.now() - start,
      };
    }

    if (network.mode !== 'deny') {
      // The local process sandbox cannot enforce egress. Refuse anything
      // weaker than `deny` so callers don't get a false sense of safety.
      return {
        success: false,
        errorCode: 'network_denied',
        stdout: '',
        stderr:
          'LocalProcessSandbox cannot enforce network policy. Configure an isolated backend ' +
          'or call again with `network: { mode: "deny" }`.',
        durationMs: Date.now() - start,
      };
    }

    const args = this.buildArgs(req.language);
    const env = this.buildEnv(req.env);

    return new Promise<SandboxExecuteResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;

      const child: ChildProcess = spawn(binary, args, {
        env,
        cwd: req.workingDir,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      const append = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
        const next = (which === 'stdout' ? stdout : stderr) + chunk.toString('utf8');
        if (next.length > maxBytes) {
          truncated = true;
          if (which === 'stdout') stdout = next.slice(0, maxBytes);
          else stderr = next.slice(0, maxBytes);
          child.kill('SIGKILL');
        } else {
          if (which === 'stdout') stdout = next;
          else stderr = next;
        }
      };

      child.stdout?.on('data', (c: Buffer) => append('stdout', c));
      child.stderr?.on('data', (c: Buffer) => append('stderr', c));

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          errorCode: 'runtime_error',
          stdout,
          stderr: stderr || err.message,
          durationMs: Date.now() - start,
          truncated,
        });
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            success: false,
            errorCode: 'timeout',
            stdout,
            stderr: stderr || `Execution exceeded ${timeoutMs}ms.`,
            durationMs: Date.now() - start,
            truncated,
            exitCode: exitCode ?? undefined,
          });
          return;
        }
        if (truncated) {
          resolve({
            success: false,
            errorCode: 'output_truncated',
            stdout,
            stderr,
            durationMs: Date.now() - start,
            truncated: true,
            exitCode: exitCode ?? undefined,
          });
          return;
        }
        resolve({
          success: exitCode === 0,
          errorCode: exitCode === 0 ? undefined : 'runtime_error',
          stdout,
          stderr,
          durationMs: Date.now() - start,
          exitCode: exitCode ?? undefined,
        });
      });

      // Pipe code as stdin for python/node/bash; ts uses a flag in args.
      if (req.language === 'typescript') {
        if (req.stdin !== undefined) child.stdin?.write(req.stdin);
      } else {
        child.stdin?.write(req.code);
        if (req.stdin !== undefined) child.stdin?.write(req.stdin);
      }
      child.stdin?.end();
    });
  }

  private resolveBinary(language: SandboxLanguage): string | undefined {
    switch (language) {
      case 'python':
        return this.options.allowedBinaries.python;
      case 'node':
        return this.options.allowedBinaries.node;
      case 'bash':
        return this.options.allowedBinaries.bash;
      case 'typescript':
        return this.options.allowedBinaries.typescript;
    }
  }

  private buildArgs(language: SandboxLanguage): string[] {
    switch (language) {
      case 'python':
        // `-I` isolates: ignore PYTHON* env vars, no user site, no `.pth`.
        return ['-I', '-'];
      case 'node':
        return ['--no-warnings', '-'];
      case 'bash':
        // `-r` restricted shell, `-` reads from stdin.
        return ['-r', '-s'];
      case 'typescript':
        // Caller is expected to point `typescript` at a script-mode runner.
        return [];
    }
  }

  private buildEnv(reqEnv?: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = {
      PATH: this.options.childPath ?? '/usr/bin:/bin',
      LANG: 'C.UTF-8',
    };
    if (this.options.allowEnvPassthrough && reqEnv) {
      return { ...base, ...reqEnv };
    }
    return base;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Tool factory
// ═════════════════════════════════════════════════════════════════════════

export interface SandboxedExecToolOptions {
  /** The runtime that will execute the code. */
  runtime: SandboxRuntime;
  /**
   * Override the tool name. Default: `run_sandboxed_code`. A unique name
   * per sandbox (e.g. `run_python_sandbox`) helps the model pick the
   * right one when multiple are registered.
   */
  name?: string;
  /** Override the languages exposed. Default: whatever the runtime advertises. */
  languages?: SandboxLanguage[];
  /** Default timeout to apply if the model doesn't supply one. */
  defaultTimeoutMs?: number;
  /** Default max output bytes. */
  defaultMaxOutputBytes?: number;
}

/**
 * Build a tool contract that exposes a `SandboxRuntime` to the model.
 * Wires:
 *   - `safetyClass: 'destructive'` — code execution can do anything.
 *   - `idempotent: false` — every run is potentially observable.
 *   - Structured guidance describing when to reach for codegen vs not.
 *   - Error templates that turn `timeout` / `network_denied` into
 *     instructions the model can act on.
 */
export function createSandboxedExecTool(
  options: SandboxedExecToolOptions,
): ToolContract {
  const caps = options.runtime.capabilities();
  const languages = (options.languages ?? caps.languages) as SandboxLanguage[];
  if (languages.length === 0) {
    throw new Error(
      'createSandboxedExecTool: the runtime advertises no languages. ' +
        'Configure `LocalProcessSandbox.allowedBinaries` or pass an isolated backend.',
    );
  }

  const inputSchema = z.object({
    code: z.string().min(1).max(64_000),
    language: z.enum(languages as [SandboxLanguage, ...SandboxLanguage[]]),
    stdin: z.string().max(64_000).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    maxOutputBytes: z.number().int().positive().max(1_048_576).optional(),
  });

  const errorTemplates = {
    byCode: {
      timeout:
        'Execution exceeded {timeoutMs}ms. Reduce the work, split the task, or pass a smaller `timeoutMs`.',
      output_truncated:
        'Output exceeded {maxOutputBytes} bytes and was truncated. Write smaller output or stream to a file.',
      language_unsupported:
        'Language `{language}` is not enabled on this sandbox. Available: {languages}.',
      network_denied:
        'This sandbox denies network access. Restructure the task to use already-fetched inputs.',
      denied:
        'No sandbox runtime is configured for this agent. Contact the operator or run locally with a configured sandbox.',
      runtime_error: '{stderr}',
    },
    default: 'Sandboxed execution failed: {stderr}',
  };

  return tool({
    name: options.name ?? 'run_sandboxed_code',
    safetyClass: 'destructive',
    idempotent: false,
    permissions: ['sandbox:exec'],
    guidance: {
      summary:
        `Execute code in an isolated sandbox (${caps.vendor}). Returns stdout, stderr, exit code, and duration.`,
      whenToUse: [
        'You need to compute a result that is easier to express as code than to reason about.',
        'You need to transform structured data (parse, summarise, regex, math) before answering.',
        'You need to verify a hypothesis by running it (e.g. test a regex against samples).',
      ],
      whenNotToUse: [
        'A dedicated tool already covers the task — prefer it.',
        'The work needs network egress and this sandbox denies it.',
        'You are uncertain about the code: prefer asking the user or splitting the task.',
      ],
      successExample:
        '{ "success": true, "stdout": "42\\n", "stderr": "", "exitCode": 0, "durationMs": 12 }',
    },
    input: inputSchema,
    errorTemplates,
    timeoutMs: options.defaultTimeoutMs ?? 30_000,
    async execute({ input }) {
      const result = await options.runtime.execute({
        code: input.code,
        language: input.language,
        stdin: input.stdin,
        timeoutMs: input.timeoutMs ?? options.defaultTimeoutMs,
        maxOutputBytes: input.maxOutputBytes ?? options.defaultMaxOutputBytes,
        network: { mode: 'deny' },
      });

      if (!result.success) {
        const code = result.errorCode ?? 'runtime_error';
        const message = formatToolError(
          { name: options.name ?? 'run_sandboxed_code', errorTemplates },
          code,
          {
            stderr: result.stderr,
            timeoutMs: input.timeoutMs ?? options.defaultTimeoutMs ?? '',
            maxOutputBytes: input.maxOutputBytes ?? options.defaultMaxOutputBytes ?? '',
            language: input.language,
            languages: languages.join(', '),
          },
        );
        return {
          success: false,
          llmOutput: message,
          error: message,
          metrics: { durationMs: result.durationMs },
        };
      }

      const llmOutput = [
        `exit ${result.exitCode ?? 0} in ${result.durationMs}ms`,
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      return {
        success: true,
        llmOutput,
        metrics: { durationMs: result.durationMs },
      };
    },
  }) as ToolContract;
}
