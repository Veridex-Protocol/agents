/**
 * SubagentTools delegation-boundary enforcement.
 *
 * Proves that when `createSubagentTools` is configured with delegation
 * enforcement, the `delegate_task` tool fail-closes: a valid delegation runs
 * the subagent under an attenuated, signed child mandate, while an
 * escalation/tamper/depth violation blocks the subagent from ever executing.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSubagentTools, type SubagentExecutor } from '../src/tools/SubagentTools';
import {
  buildMandateCredential,
  type MandateCredential,
  type MandateCredentialSubject,
} from '../src/credentials/MandateCredential';
import { DelegationGuard, HmacMandateSigner, signMandate } from '../src/credentials/DelegationGuard';
import type { AgentDefinition } from '../src/types/agent';

const SECRET = 'subagent-delegation-secret';

function subject(overrides: Partial<MandateCredentialSubject> = {}): MandateCredentialSubject {
  return {
    agentId: 'agent-A',
    principalId: 'principal-1',
    spendingLimits: { maxAmountUSD: 100 },
    actionConstraints: { allowedTools: ['search', 'summarize'] },
    delegation: {
      delegatorAgentId: 'principal-1',
      delegateAgentId: 'agent-A',
      depth: 0,
      maxDepth: 2,
      purpose: 'root',
    },
    ...overrides,
  };
}

async function signedParent(
  signer: HmacMandateSigner,
  subj: MandateCredentialSubject = subject(),
): Promise<MandateCredential> {
  return signMandate(
    buildMandateCredential({ id: 'urn:uuid:parent', issuer: 'did:veridex:issuer', subject: subj }),
    signer,
  );
}

const researcherDef = {
  id: 'agent-researcher',
  name: 'researcher',
  model: { provider: 'test', model: 'test' },
} as unknown as AgentDefinition;

function makeTool(
  signer: HmacMandateSigner,
  parentMandate: MandateCredential,
  executor: SubagentExecutor,
  scopeFor?: Parameters<typeof createSubagentTools>[0]['delegation'] extends infer D
    ? D extends { scopeFor?: infer S }
      ? S
      : never
    : never,
) {
  return createSubagentTools({
    agents: [{ name: 'researcher', description: 'Researches things.', definition: researcherDef }],
    executor,
    delegation: {
      guard: new DelegationGuard({ signer, verifier: signer }),
      parentMandate,
      issuer: 'did:veridex:issuer',
      scopeFor,
    },
  });
}

describe('createSubagentTools delegation enforcement', () => {
  it('runs the subagent under an attenuated, signed child mandate when authorized', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const parent = await signedParent(signer);

    const executor = vi.fn<Parameters<SubagentExecutor>, ReturnType<SubagentExecutor>>(
      async () => ({ success: true, output: 'done' }),
    );

    const delegateTool = makeTool(signer, parent, executor, (_entry, _input) => ({
      requestedScope: { spendingLimits: { maxAmountUSD: 25 }, actionConstraints: { allowedTools: ['search'] } },
    }));

    const result = await delegateTool.execute({
      input: { agent: 'researcher', task: 'Find sources' },
    } as never);

    expect(result.success).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);

    // The runtime options handed to the subagent carry the scoped child mandate.
    const passedOptions = executor.mock.calls[0][2];
    const childMandate = passedOptions?.mandate as MandateCredential | undefined;
    expect(childMandate).toBeDefined();
    expect(childMandate!.credentialSubject.spendingLimits.maxAmountUSD).toBe(25);
    expect(childMandate!.credentialSubject.actionConstraints.allowedTools).toEqual(['search']);
    expect(childMandate!.credentialSubject.delegation?.depth).toBe(1);
    expect(childMandate!.proof).toBeDefined();
  });

  it('denies delegation and never runs the subagent on a tool-escalation attempt', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const parent = await signedParent(signer);
    const executor = vi.fn<Parameters<SubagentExecutor>, ReturnType<SubagentExecutor>>(
      async () => ({ success: true, output: 'should not run' }),
    );

    const delegateTool = makeTool(signer, parent, executor, () => ({
      requestedScope: { actionConstraints: { allowedTools: ['drain_treasury'] } },
    }));

    const result = await delegateTool.execute({
      input: { agent: 'researcher', task: 'do something sneaky' },
    } as never);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/delegation_denied/);
    expect(executor).not.toHaveBeenCalled();
  });

  it('denies delegation when the parent mandate has been tampered with', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const parent = await signedParent(signer);
    parent.credentialSubject.spendingLimits.maxAmountUSD = 1_000_000; // tamper post-signing

    const executor = vi.fn<Parameters<SubagentExecutor>, ReturnType<SubagentExecutor>>(
      async () => ({ success: true, output: 'should not run' }),
    );
    const delegateTool = makeTool(signer, parent, executor);

    const result = await delegateTool.execute({
      input: { agent: 'researcher', task: 'anything' },
    } as never);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/delegation_denied/);
    expect(executor).not.toHaveBeenCalled();
  });

  it('denies delegation past the depth ceiling', async () => {
    const signer = new HmacMandateSigner(SECRET);
    const parent = await signedParent(
      signer,
      subject({
        delegation: {
          delegatorAgentId: 'x',
          delegateAgentId: 'agent-A',
          depth: 2,
          maxDepth: 2,
          purpose: 'root',
        },
      }),
    );
    const executor = vi.fn<Parameters<SubagentExecutor>, ReturnType<SubagentExecutor>>(
      async () => ({ success: true, output: 'should not run' }),
    );
    const delegateTool = makeTool(signer, parent, executor);

    const result = await delegateTool.execute({
      input: { agent: 'researcher', task: 'too deep' },
    } as never);

    expect(result.success).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });

  it('leaves delegation unrestricted when no enforcement is configured (back-compat)', async () => {
    const executor = vi.fn<Parameters<SubagentExecutor>, ReturnType<SubagentExecutor>>(
      async () => ({ success: true, output: 'ok' }),
    );
    const delegateTool = createSubagentTools({
      agents: [{ name: 'researcher', description: 'x', definition: researcherDef }],
      executor,
    });

    const result = await delegateTool.execute({
      input: { agent: 'researcher', task: 'plain delegation' },
    } as never);

    expect(result.success).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][2]?.mandate).toBeUndefined();
  });
});
