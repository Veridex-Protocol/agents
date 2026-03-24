import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalManager } from '../src/approvals';
import type { ApprovalRoute, ApprovalHandler } from '../src/approvals';
import type { ActionProposal } from '../src/types/proposals';
import type { PolicyDecision } from '../src/types/policy';

function makeProposal(toolNames: string[] = ['transfer']): ActionProposal {
  return {
    type: 'tool_call',
    toolCalls: toolNames.map((name, i) => ({
      id: `tc_${i}`,
      name,
      arguments: {},
    })),
  } as ActionProposal;
}

function makeDecision(verdict: 'pass' | 'flag' | 'escalate' | 'block' = 'escalate'): PolicyDecision {
  return {
    verdict,
    riskScore: verdict === 'block' ? 1 : verdict === 'escalate' ? 0.7 : 0.3,
    reasons: [`Verdict: ${verdict}`],
    checks: [],
    evaluatedAt: Date.now(),
  };
}

describe('ApprovalManager', () => {
  let manager: ApprovalManager;

  beforeEach(() => {
    manager = new ApprovalManager();
  });

  it('auto-allows when policy says pass', async () => {
    const decision = await manager.requestApproval(
      'run_1', 'agent_1', 0,
      makeProposal(), makeDecision('pass'),
    );
    expect(decision.approved).toBe(true);
    expect(decision.decidedBy).toContain('auto_allow');
  });

  it('auto-blocks when policy says block', async () => {
    const decision = await manager.requestApproval(
      'run_1', 'agent_1', 0,
      makeProposal(), makeDecision('block'),
    );
    expect(decision.approved).toBe(false);
    expect(decision.decidedBy).toContain('auto_block');
  });

  it('escalateS to human_required by default', async () => {
    // Without a handler for human_required, should block with "no handler"
    const decision = await manager.requestApproval(
      'run_1', 'agent_1', 0,
      makeProposal(), makeDecision('escalate'),
    );
    // No handler registered for human_required → blocks
    expect(decision.approved).toBe(false);
    expect(decision.decidedBy).toContain('no_handler');
  });

  it('routes to custom handler for human_required', async () => {
    const handler: ApprovalHandler = async (req) => ({
      requestId: req.id,
      approved: true,
      decidedBy: 'admin@example.com',
      reason: 'Manually approved',
      decidedAt: Date.now(),
    });

    manager.registerHandler('human_required', handler);

    const decision = await manager.requestApproval(
      'run_1', 'agent_1', 0,
      makeProposal(), makeDecision('escalate'),
    );
    expect(decision.approved).toBe(true);
    expect(decision.decidedBy).toBe('admin@example.com');
  });

  it('custom routes override defaults', async () => {
    // Route: always auto-allow, even for escalated verdicts
    manager.addRoute({
      match: () => true,
      mode: 'auto_allow',
    });

    const decision = await manager.requestApproval(
      'run_1', 'agent_1', 0,
      makeProposal(), makeDecision('escalate'),
    );
    expect(decision.approved).toBe(true);
    expect(decision.decidedBy).toContain('auto_allow');
  });

  it('records decisions', async () => {
    await manager.requestApproval('run_1', 'agent_1', 0, makeProposal(), makeDecision('pass'));
    await manager.requestApproval('run_2', 'agent_1', 0, makeProposal(), makeDecision('pass'));

    const decisions = manager.getDecisions();
    expect(decisions).toHaveLength(2);
  });

  it('manually resolves pending requests', async () => {
    // Register a human_required handler that stores the request for later resolution
    let resolveExternal: ((d: Awaited<ReturnType<ApprovalHandler>>) => void) | undefined;
    manager.registerHandler('human_required', (req) => {
      return new Promise((resolve) => {
        resolveExternal = resolve;
      });
    });

    const resultPromise = manager.requestApproval(
      'run_1', 'agent_1', 0,
      makeProposal(), makeDecision('escalate'),
    );

    // Resolve externally
    resolveExternal!({
      requestId: 'test',
      approved: true,
      decidedBy: 'reviewer',
      reason: 'Looks good',
      decidedAt: Date.now(),
    });

    const decision = await resultPromise;
    expect(decision.approved).toBe(true);
    expect(decision.decidedBy).toBe('reviewer');
  });

  it('clears all state', async () => {
    await manager.requestApproval('run_1', 'agent_1', 0, makeProposal(), makeDecision('pass'));
    manager.clear();
    expect(manager.getDecisions()).toHaveLength(0);
    expect(manager.getPending()).toHaveLength(0);
  });

  it('clears routes', async () => {
    manager.addRoute({ match: () => true, mode: 'auto_block' });
    manager.clearRoutes();

    const decision = await manager.requestApproval(
      'run_1', 'agent_1', 0,
      makeProposal(), makeDecision('pass'),
    );
    expect(decision.approved).toBe(true);
  });
});
