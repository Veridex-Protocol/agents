import { describe, it, expect, vi } from 'vitest';
import {
  buildDeployBundle,
  renderDockerfile,
  renderK8sManifest,
  runDeployCli,
  validateDeploySpec,
  type DeploySpec,
  type DeployArtifact,
} from '../src/deploy';

const baseSpec: DeploySpec = {
  id: 'demo-agent',
  version: '1.2.3',
  name: 'Demo',
  entrypoint: 'dist/server.js',
  port: 8080,
  replicas: 2,
  env: { LOG_LEVEL: 'info' },
  secretRefs: ['OPENAI_API_KEY'],
  mcpServers: [
    { id: 'fs', transport: 'stdio', endpoint: 'node ./mcp-fs.js' },
  ],
  sandbox: {
    backend: 'e2b',
    timeoutMs: 30000,
    languages: ['python', 'bash'],
    network: 'allowlist',
    allowedHosts: ['api.example.com'],
  },
  resources: { cpu: '250m', memory: '256Mi', cpuLimit: '500m', memoryLimit: '512Mi' },
};

describe('validateDeploySpec', () => {
  it('returns no errors for a valid spec', () => {
    expect(validateDeploySpec(baseSpec)).toEqual([]);
  });

  it('rejects bad id / version', () => {
    const errors = validateDeploySpec({ ...baseSpec, id: 'Bad ID', version: 'x' });
    expect(errors.some((e) => e.includes('id'))).toBe(true);
    expect(errors.some((e) => e.includes('version'))).toBe(true);
  });

  it('rejects allowlist without hosts', () => {
    const errors = validateDeploySpec({
      ...baseSpec,
      sandbox: { backend: 'e2b', network: 'allowlist' },
    });
    expect(errors.some((e) => e.includes('allowedHosts'))).toBe(true);
  });

  it('rejects relative-path traversal in skills', () => {
    const errors = validateDeploySpec({ ...baseSpec, skills: ['../escape'] });
    expect(errors.some((e) => e.includes("'..'"))).toBe(true);
  });
});

describe('renderDockerfile', () => {
  it('contains HEALTHCHECK, non-root user, and pinned base by default', () => {
    const df = renderDockerfile(baseSpec);
    expect(df).toContain('HEALTHCHECK');
    expect(df).toContain('USER agent');
    expect(df).toContain('node:20-alpine');
    expect(df).toContain('EXPOSE 8080');
  });
});

describe('renderK8sManifest', () => {
  it('emits Deployment + Service with probes and securityContext', () => {
    const y = renderK8sManifest(baseSpec);
    expect(y).toContain('kind: Deployment');
    expect(y).toContain('kind: Service');
    expect(y).toContain('runAsNonRoot: true');
    expect(y).toContain('livenessProbe');
    expect(y).toContain('readinessProbe');
    expect(y).toContain('replicas: 2');
    expect(y).toContain('secretKeyRef');
  });
});

describe('buildDeployBundle', () => {
  it('produces all expected artifacts and a stable hash', () => {
    const a = buildDeployBundle(baseSpec);
    const b = buildDeployBundle(baseSpec);
    expect(a.hash).toBe(b.hash);
    const paths = a.artifacts.map((x) => x.path).sort();
    expect(paths).toEqual(
      [
        '.dockerignore',
        'Dockerfile',
        'README.deploy.md',
        'agent.manifest.json',
        'deploy/k8s.yaml',
        'deploy/mcp.config.json',
        'deploy/policy.config.json',
      ].sort(),
    );
    expect(a.imageTag).toBe('demo-agent:1.2.3');
  });

  it('throws on invalid spec', () => {
    expect(() =>
      buildDeployBundle({ ...baseSpec, id: 'BAD!' } as DeploySpec),
    ).toThrow(/Invalid DeploySpec/);
  });
});

describe('runDeployCli', () => {
  it('help exits 0 with usage', async () => {
    const r = await runDeployCli(['help'], { cwd: '/tmp' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('veridex deploy');
  });

  it('unknown command exits 2', async () => {
    const r = await runDeployCli(['nope'], { cwd: '/tmp' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Unknown command');
  });

  it('validate command reports OK on valid spec', async () => {
    const r = await runDeployCli(['validate', 'spec.json'], {
      cwd: '/tmp',
      readSpec: async () => baseSpec,
    });
    expect(r.exitCode).toBe(0);
  });

  it('bundle writes artifacts via injected writer', async () => {
    const writer = vi.fn(async (_: string, __: readonly DeployArtifact[]) => {});
    const r = await runDeployCli(
      ['bundle', 'spec.json', '--out', 'out/dir'],
      {
        cwd: '/tmp',
        readSpec: async () => baseSpec,
        writeArtifacts: writer,
      },
    );
    expect(r.exitCode).toBe(0);
    expect(writer).toHaveBeenCalledOnce();
    expect(writer.mock.calls[0][0]).toBe('out/dir');
    expect(writer.mock.calls[0][1].length).toBeGreaterThan(3);
  });

  it('deploy --register calls the registrar', async () => {
    const writer = vi.fn(async () => {});
    const register = vi.fn(async () => ({
      deploymentId: 'd-1',
      url: 'https://cp/deployments/d-1',
    }));
    const r = await runDeployCli(
      ['deploy', 'spec.json', '--out', 'o', '--register'],
      {
        cwd: '/tmp',
        readSpec: async () => baseSpec,
        writeArtifacts: writer,
        registrar: { register },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(register).toHaveBeenCalledOnce();
    expect(r.stdout).toContain('Registered: d-1');
  });

  it('deploy --register without registrar exits 2', async () => {
    const r = await runDeployCli(
      ['deploy', 'spec.json', '--out', 'o', '--register'],
      {
        cwd: '/tmp',
        readSpec: async () => baseSpec,
        writeArtifacts: async () => {},
      },
    );
    expect(r.exitCode).toBe(2);
  });
});
