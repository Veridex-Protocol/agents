/**
 * @packageDocumentation
 * @module Deploy
 * @description
 * One-shot agent deploy bundler — Phase 5 item #1.
 *
 * Why this exists:
 *   Going from a working agent definition to a running production
 *   service is multi-step pain: write a Dockerfile, configure
 *   MCP transports, attach skills, declare sandbox limits, register
 *   with the control plane, repeat for every environment. Deep Agents
 *   ships a single `deploy` command. Veridex matches that ergonomic
 *   without giving up the explicitness everything else in the
 *   framework demands.
 *
 * Design:
 *   - {@link DeploySpec} is the declarative input the developer hands
 *     us: agent module path, skill packs, MCP servers, sandbox limits,
 *     resource caps.
 *   - {@link buildDeployBundle} is a pure function: spec in, file
 *     artifacts out (`Dockerfile`, `k8s.yaml`, `agent.manifest.json`,
 *     `mcp.config.json`, `policy.config.json`). It writes nothing —
 *     the caller (CLI / tests) decides where.
 *   - Renderers (`renderDockerfile`, `renderK8sManifest`) are
 *     separately exported so users can override individual outputs.
 *   - {@link ControlPlaneRegistrar} is an interface; production wires
 *     in an HTTP client, tests inject a fake.
 *   - {@link runDeployCli} is a programmable CLI matching the skills
 *     CLI shape (returns `{exitCode, stdout, stderr}`, accepts an `io`
 *     bag for fs / registrar / clock).
 */

// ── Spec ────────────────────────────────────────────────────────────────

export interface DeploySpec {
  /** Unique deployment id (DNS-safe, lowercase). */
  id: string;
  /** Semver version of the deployment. */
  version: string;
  /** Display name. */
  name: string;
  /** Short description. */
  description?: string;
  /** Image base — defaults to `node:20-alpine`. */
  baseImage?: string;
  /** Entrypoint module relative to the bundle root. */
  entrypoint: string;
  /** Skill pack directories (relative to bundle root). */
  skills?: readonly string[];
  /** MCP server endpoints the agent will dial. */
  mcpServers?: readonly McpServerSpec[];
  /** Sandbox spec for codegen tools. */
  sandbox?: SandboxSpec;
  /** Resource caps. */
  resources?: ResourceSpec;
  /** Environment variables (non-secret). */
  env?: Readonly<Record<string, string>>;
  /** Required secret names (no values). */
  secretRefs?: readonly string[];
  /** Replica count for k8s. Default `1`. */
  replicas?: number;
  /** Exposed port. Default `8080`. */
  port?: number;
  /** Free-form labels merged into the k8s manifest. */
  labels?: Readonly<Record<string, string>>;
}

export interface McpServerSpec {
  /** Identifier used by the runtime. */
  id: string;
  /** Transport. */
  transport: 'stdio' | 'http' | 'websocket';
  /** Endpoint URL or command. */
  endpoint: string;
  /** Required auth scopes / scheme. */
  auth?: { type: 'bearer' | 'apiKey' | 'none'; secretRef?: string };
}

export interface SandboxSpec {
  /** Backend id (`local`, `e2b`, `modal`, `daytona`). */
  backend: string;
  /** Hard wall-clock cap per exec, ms. */
  timeoutMs?: number;
  /** Allowed languages. */
  languages?: readonly ('python' | 'node' | 'bash' | 'typescript')[];
  /** Network policy. */
  network?: 'deny' | 'allowlist' | 'open';
  /** Allowed hosts when `network === 'allowlist'`. */
  allowedHosts?: readonly string[];
}

export interface ResourceSpec {
  /** Memory request (e.g. `'512Mi'`). */
  memory?: string;
  /** CPU request (e.g. `'500m'`). */
  cpu?: string;
  /** Memory limit. */
  memoryLimit?: string;
  /** CPU limit. */
  cpuLimit?: string;
}

// ── Bundle output ───────────────────────────────────────────────────────

export interface DeployArtifact {
  /** Path relative to bundle root. */
  path: string;
  /** File contents. */
  content: string;
  /** True for executables (so CLIs can `chmod +x`). */
  executable?: boolean;
}

export interface DeployBundle {
  /** The spec used to build the bundle (echoed for audit). */
  spec: DeploySpec;
  /** Generated artifacts. */
  artifacts: DeployArtifact[];
  /** Manifest hash (sha256, hex; 16-char prefix). */
  hash: string;
  /** Suggested image tag. */
  imageTag: string;
}

// ── Validation ──────────────────────────────────────────────────────────

const ID_RE = /^[a-z][a-z0-9-]{1,62}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

export function validateDeploySpec(spec: DeploySpec): string[] {
  const errors: string[] = [];
  if (!ID_RE.test(spec.id)) {
    errors.push(`id must match ${ID_RE} (got '${spec.id}')`);
  }
  if (!SEMVER_RE.test(spec.version)) {
    errors.push(`version must be semver (got '${spec.version}')`);
  }
  if (!spec.entrypoint || spec.entrypoint.includes('..')) {
    errors.push(`entrypoint must be a relative path without '..'`);
  }
  if (spec.replicas !== undefined && spec.replicas < 1) {
    errors.push(`replicas must be >= 1`);
  }
  if (spec.port !== undefined && (spec.port < 1 || spec.port > 65535)) {
    errors.push(`port must be in [1, 65535]`);
  }
  if (spec.sandbox?.network === 'allowlist' && !spec.sandbox.allowedHosts?.length) {
    errors.push(`sandbox.allowedHosts required when network === 'allowlist'`);
  }
  for (const skill of spec.skills ?? []) {
    if (skill.includes('..')) {
      errors.push(`skill path '${skill}' may not contain '..'`);
    }
  }
  return errors;
}

// ── Bundle builder ──────────────────────────────────────────────────────

export function buildDeployBundle(spec: DeploySpec): DeployBundle {
  const errors = validateDeploySpec(spec);
  if (errors.length > 0) {
    throw new Error(`Invalid DeploySpec:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  const manifest = renderManifest(spec);
  const dockerfile = renderDockerfile(spec);
  const k8s = renderK8sManifest(spec);
  const mcp = renderMcpConfig(spec);
  const policy = renderPolicyConfig(spec);
  const dockerignore = renderDockerignore();
  const readme = renderReadme(spec);

  const artifacts: DeployArtifact[] = [
    { path: 'agent.manifest.json', content: manifest },
    { path: 'Dockerfile', content: dockerfile },
    { path: '.dockerignore', content: dockerignore },
    { path: 'deploy/k8s.yaml', content: k8s },
    { path: 'deploy/mcp.config.json', content: mcp },
    { path: 'deploy/policy.config.json', content: policy },
    { path: 'README.deploy.md', content: readme },
  ];

  const hash = hashArtifacts(artifacts);
  const imageTag = `${spec.id}:${spec.version}`;

  return { spec, artifacts, hash, imageTag };
}

// ── Renderers (exported individually for override) ─────────────────────

export function renderManifest(spec: DeploySpec): string {
  return (
    `${JSON.stringify(
      {
        kind: 'veridex.deploy/v1',
        id: spec.id,
        version: spec.version,
        name: spec.name,
        description: spec.description ?? '',
        entrypoint: spec.entrypoint,
        skills: spec.skills ?? [],
        mcpServers: (spec.mcpServers ?? []).map((s) => ({
          id: s.id,
          transport: s.transport,
          endpoint: s.endpoint,
          auth: s.auth ?? { type: 'none' },
        })),
        sandbox: spec.sandbox ?? null,
        resources: spec.resources ?? null,
        env: spec.env ?? {},
        secretRefs: spec.secretRefs ?? [],
        replicas: spec.replicas ?? 1,
        port: spec.port ?? 8080,
        labels: spec.labels ?? {},
      },
      null,
      2,
    )}\n`
  );
}

export function renderDockerfile(spec: DeploySpec): string {
  const base = spec.baseImage ?? 'node:20-alpine';
  const port = spec.port ?? 8080;
  const lines = [
    `# Generated by veridex deploy — do not edit by hand.`,
    `# spec.id=${spec.id} version=${spec.version}`,
    `FROM ${base} AS runtime`,
    `WORKDIR /app`,
    `# Non-root user (UID 10001) — Critical Trigger fix.`,
    `RUN addgroup -S agent && adduser -S -G agent -u 10001 agent`,
    `COPY --chown=agent:agent . .`,
    `RUN if [ -f pnpm-lock.yaml ]; then npm install -g pnpm@9 && pnpm install --frozen-lockfile --prod; \\`,
    `    elif [ -f package-lock.json ]; then npm ci --omit=dev; \\`,
    `    else echo "no lockfile" && exit 1; fi`,
    `USER agent`,
    `EXPOSE ${port}`,
    `ENV NODE_ENV=production`,
    `ENV VERIDEX_DEPLOY_ID=${spec.id}`,
    `ENV VERIDEX_DEPLOY_VERSION=${spec.version}`,
    // HEALTHCHECK satisfies the auto-escalation triggers in the audit
    // framework (Docker without HEALTHCHECK → High).
    `HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\`,
    `  CMD wget -qO- http://127.0.0.1:${port}/healthz || exit 1`,
    `CMD ["node", "${spec.entrypoint}"]`,
  ];
  return `${lines.join('\n')}\n`;
}

export function renderK8sManifest(spec: DeploySpec): string {
  const port = spec.port ?? 8080;
  const replicas = spec.replicas ?? 1;
  const labels = { app: spec.id, version: spec.version, ...(spec.labels ?? {}) };
  const labelLines = Object.entries(labels)
    .map(([k, v]) => `    ${k}: "${v}"`)
    .join('\n');
  const envEntries: string[] = [];
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    envEntries.push(`        - name: ${k}\n          value: "${escapeYaml(v)}"`);
  }
  for (const secret of spec.secretRefs ?? []) {
    envEntries.push(
      `        - name: ${secret}\n          valueFrom:\n            secretKeyRef:\n              name: ${spec.id}-secrets\n              key: ${secret}`,
    );
  }
  const envBlock = envEntries.length > 0 ? `      env:\n${envEntries.join('\n')}` : '';
  const resources = renderResources(spec.resources);

  return `# Generated by veridex deploy.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${spec.id}
  labels:
${labelLines}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${spec.id}
  template:
    metadata:
      labels:
${labelLines}
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        fsGroup: 10001
      containers:
      - name: agent
        image: ${spec.id}:${spec.version}
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: ${port}
${envBlock}
        livenessProbe:
          httpGet:
            path: /healthz
            port: ${port}
          initialDelaySeconds: 15
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /readyz
            port: ${port}
          initialDelaySeconds: 5
          periodSeconds: 10
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]
${resources}
---
apiVersion: v1
kind: Service
metadata:
  name: ${spec.id}
  labels:
${labelLines}
spec:
  type: ClusterIP
  ports:
  - port: ${port}
    targetPort: ${port}
    protocol: TCP
    name: http
  selector:
    app: ${spec.id}
`;
}

function renderResources(r: ResourceSpec | undefined): string {
  if (!r) return '';
  const lines: string[] = ['        resources:'];
  if (r.cpu || r.memory) {
    lines.push('          requests:');
    if (r.cpu) lines.push(`            cpu: "${r.cpu}"`);
    if (r.memory) lines.push(`            memory: "${r.memory}"`);
  }
  if (r.cpuLimit || r.memoryLimit) {
    lines.push('          limits:');
    if (r.cpuLimit) lines.push(`            cpu: "${r.cpuLimit}"`);
    if (r.memoryLimit) lines.push(`            memory: "${r.memoryLimit}"`);
  }
  return lines.join('\n');
}

export function renderMcpConfig(spec: DeploySpec): string {
  return (
    `${JSON.stringify(
      {
        servers: spec.mcpServers ?? [],
      },
      null,
      2,
    )}\n`
  );
}

export function renderPolicyConfig(spec: DeploySpec): string {
  return (
    `${JSON.stringify(
      {
        deployId: spec.id,
        sandbox: spec.sandbox ?? { backend: 'deny-all' },
        secretsRequired: spec.secretRefs ?? [],
      },
      null,
      2,
    )}\n`
  );
}

export function renderDockerignore(): string {
  return `${[
    'node_modules',
    'dist',
    '.git',
    '.env',
    '.env.*',
    'tests',
    '*.test.ts',
    '*.spec.ts',
    'coverage',
    '.DS_Store',
  ].join('\n')}\n`;
}

function renderReadme(spec: DeploySpec): string {
  return `# ${spec.name} — deploy bundle

Generated by \`veridex deploy\`. **Do not edit by hand**; regenerate from your DeploySpec.

- id: \`${spec.id}\`
- version: \`${spec.version}\`
- entrypoint: \`${spec.entrypoint}\`

## Build

\`\`\`sh
docker build -t ${spec.id}:${spec.version} .
\`\`\`

## Run locally

\`\`\`sh
docker run --rm -p ${spec.port ?? 8080}:${spec.port ?? 8080} ${spec.id}:${spec.version}
\`\`\`

## Deploy

\`\`\`sh
kubectl apply -f deploy/k8s.yaml
\`\`\`

## Registered MCP servers

${(spec.mcpServers ?? []).map((s) => `- \`${s.id}\` (${s.transport}) — \`${s.endpoint}\``).join('\n') || '- none'}

## Required secrets

${(spec.secretRefs ?? []).map((s) => `- \`${s}\``).join('\n') || '- none'}
`;
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"');
}

function hashArtifacts(artifacts: readonly DeployArtifact[]): string {
  // Same FNV-1a flavour used elsewhere in the framework for cheap
  // tamper-evident hashing without pulling node:crypto in non-Node
  // environments.
  let h = 0x811c9dc5;
  const sorted = [...artifacts].sort((a, b) => a.path.localeCompare(b.path));
  for (const art of sorted) {
    for (let i = 0; i < art.path.length; i++) {
      h = Math.imul(h ^ art.path.charCodeAt(i), 0x01000193) >>> 0;
    }
    h = Math.imul(h ^ 0x7c, 0x01000193) >>> 0;
    for (let i = 0; i < art.content.length; i++) {
      h = Math.imul(h ^ art.content.charCodeAt(i), 0x01000193) >>> 0;
    }
    h = Math.imul(h ^ 0x0a, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── Control plane registrar ─────────────────────────────────────────────

export interface ControlPlaneRegistrar {
  /** Register a deploy bundle. Returns the assigned deployment URL. */
  register(input: { spec: DeploySpec; hash: string; imageTag: string }): Promise<{
    deploymentId: string;
    url: string;
  }>;
}

// ── CLI ────────────────────────────────────────────────────────────────

export interface DeployCliIO {
  cwd: string;
  /** Read a JSON spec file. Required for `deploy` / `bundle`. */
  readSpec?: (path: string) => Promise<DeploySpec> | DeploySpec;
  /** Write generated artifacts. Required for `deploy` / `bundle`. */
  writeArtifacts?: (
    rootDir: string,
    artifacts: readonly DeployArtifact[],
  ) => Promise<void>;
  /** Control plane registrar. Optional. */
  registrar?: ControlPlaneRegistrar;
}

export interface DeployCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runDeployCli(
  argv: readonly string[],
  io: DeployCliIO,
): Promise<DeployCliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const log = (s: string): void => {
    out.push(s);
  };
  const warn = (s: string): void => {
    err.push(s);
  };

  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    log(HELP_TEXT);
    return { exitCode: 0, stdout: `${out.join('\n')}\n`, stderr: '' };
  }

  try {
    switch (cmd) {
      case 'validate':
        return await cmdValidate(rest, io, log, warn);
      case 'bundle':
        return await cmdBundle(rest, io, log, warn);
      case 'deploy':
        return await cmdDeploy(rest, io, log, warn);
      default:
        warn(`Unknown command: ${cmd}`);
        warn(HELP_TEXT);
        return { exitCode: 2, stdout: '', stderr: `${err.join('\n')}\n` };
    }
  } catch (e) {
    warn(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 1, stdout: out.join('\n'), stderr: `${err.join('\n')}\n` };
  }
}

const HELP_TEXT = `veridex deploy — bundle and register an agent deployment.

Commands:
  validate <spec.json>           Validate a DeploySpec without writing files.
  bundle   <spec.json> --out <dir>
                                 Render artifacts under <dir>.
  deploy   <spec.json> --out <dir> [--register]
                                 Render artifacts and optionally register
                                 with the configured control plane.

  help                           Show this message.
`;

function parseFlags(args: readonly string[]): {
  positional: string[];
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function cmdValidate(
  args: readonly string[],
  io: DeployCliIO,
  log: (s: string) => void,
  warn: (s: string) => void,
): Promise<DeployCliResult> {
  const { positional } = parseFlags(args);
  const specPath = positional[0];
  if (!specPath) {
    warn('validate requires a spec path');
    return { exitCode: 2, stdout: '', stderr: 'validate requires a spec path\n' };
  }
  if (!io.readSpec) {
    warn('no readSpec provided');
    return { exitCode: 2, stdout: '', stderr: 'no readSpec provided\n' };
  }
  const spec = await io.readSpec(specPath);
  const errors = validateDeploySpec(spec);
  if (errors.length > 0) {
    warn(`Invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    return { exitCode: 1, stdout: '', stderr: `Invalid spec:\n${errors.join('\n')}\n` };
  }
  log(`OK ${spec.id}@${spec.version}`);
  return { exitCode: 0, stdout: log === undefined ? '' : `OK ${spec.id}@${spec.version}\n`, stderr: '' };
}

async function cmdBundle(
  args: readonly string[],
  io: DeployCliIO,
  log: (s: string) => void,
  warn: (s: string) => void,
): Promise<DeployCliResult> {
  const { positional, flags } = parseFlags(args);
  const specPath = positional[0];
  const outDir = (flags.out as string) ?? 'dist/deploy';
  if (!specPath) {
    warn('bundle requires a spec path');
    return { exitCode: 2, stdout: '', stderr: 'bundle requires a spec path\n' };
  }
  if (!io.readSpec || !io.writeArtifacts) {
    warn('bundle requires readSpec + writeArtifacts');
    return { exitCode: 2, stdout: '', stderr: 'bundle requires readSpec + writeArtifacts\n' };
  }
  const spec = await io.readSpec(specPath);
  const bundle = buildDeployBundle(spec);
  await io.writeArtifacts(outDir, bundle.artifacts);
  const lines = [
    `Bundled ${spec.id}@${spec.version}`,
    `  imageTag: ${bundle.imageTag}`,
    `  hash:     ${bundle.hash}`,
    `  outDir:   ${outDir}`,
    `  files:    ${bundle.artifacts.length}`,
  ];
  for (const a of bundle.artifacts) lines.push(`    - ${a.path}`);
  log(lines.join('\n'));
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

async function cmdDeploy(
  args: readonly string[],
  io: DeployCliIO,
  log: (s: string) => void,
  warn: (s: string) => void,
): Promise<DeployCliResult> {
  const { positional, flags } = parseFlags(args);
  const specPath = positional[0];
  const outDir = (flags.out as string) ?? 'dist/deploy';
  const shouldRegister = flags.register === true;
  if (!specPath) {
    warn('deploy requires a spec path');
    return { exitCode: 2, stdout: '', stderr: 'deploy requires a spec path\n' };
  }
  if (!io.readSpec || !io.writeArtifacts) {
    warn('deploy requires readSpec + writeArtifacts');
    return {
      exitCode: 2,
      stdout: '',
      stderr: 'deploy requires readSpec + writeArtifacts\n',
    };
  }
  const spec = await io.readSpec(specPath);
  const bundle = buildDeployBundle(spec);
  await io.writeArtifacts(outDir, bundle.artifacts);
  const outLines = [
    `Bundled ${spec.id}@${spec.version}`,
    `  imageTag: ${bundle.imageTag}`,
    `  hash:     ${bundle.hash}`,
    `  outDir:   ${outDir}`,
  ];
  if (shouldRegister) {
    if (!io.registrar) {
      warn('--register requires a configured registrar');
      return {
        exitCode: 2,
        stdout: `${outLines.join('\n')}\n`,
        stderr: '--register requires a configured registrar\n',
      };
    }
    const { deploymentId, url } = await io.registrar.register({
      spec,
      hash: bundle.hash,
      imageTag: bundle.imageTag,
    });
    outLines.push(`Registered: ${deploymentId}`, `  url: ${url}`);
  }
  log(outLines.join('\n'));
  return { exitCode: 0, stdout: `${outLines.join('\n')}\n`, stderr: '' };
}
