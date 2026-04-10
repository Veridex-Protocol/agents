/**
 * Tests for approval handler wiring in ApprovalManager.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ApprovalManager,
  type ApprovalHandler,
  type ApprovalRoute,
} from '../src/approvals/ApprovalManager';
import type { ActionProposal } from '../src/types/proposals';
import type { PolicyDecision } from '../src/types/policy';

function makeProposal(type = 'tool_call'): ActionProposal {
  return {
    type: type as ActionProposal['type'],
    source: 'model',
    description: 'Test action',
    riskHints: [],
    metadata: {},
  } as ActionProposal;
}

function makePolicy(risk = 80): PolicyDecision {
  return {
    allowed: false,
    riskScore: risk,
    reasons: ['high risk'],
    requiresApproval: true,
    appliedRules: [],
  };
}

describe('ApprovalManager handler wiring', () => {
  it('auto_allow resolves immediately', async () => {
    const mgr = new ApprovalManager();
    const result = await mgr.startApproval('r1', 'a1', 0, makeProposal(), makePolicy(), { autoResolve: true });
    // Default routes don't override mode — falls through to policy-based mode.
    // With autoResolve: true the handler runs regardless.
    expect(result.request).toBeDefined();
  });

  it('registerHandler allows custom human_required handler to run', async () => {
    const mgr = new ApprovalManager();

    // Route all proposals to human_required
    const route: ApprovalRoute = {
      match: () => true,
      mode: 'human_required',
    };
    mgr.addRoute(route);

    // Register a custom handler
    const handler: ApprovalHandler = vi.fn(async (req) => ({
      requestId: req.id,
      approved: true,
      decidedBy: 'test:human',
      reason: 'Approved by test',
      decidedAt: Date.now(),
    }));
    mgr.registerHandler('human_required', handler);

    // Even with autoResolve: false, the handler should run because it's registered
    const result = await mgr.startApproval('r1', 'a1', 0, makeProposal(), makePolicy(), { autoResolve: false });

    expect(handler).toHaveBeenCalledOnce();
    expect(result.decision).toBeDefined();
    expect(result.decision!.approved).toBe(true);
    expect(result.decision!.decidedBy).toBe('test:human');
  });

  it('unregistered human_required handler suspends when autoResolve false', async () => {
    const mgr = new ApprovalManager();

    // Route to human_required but don't register a handler
    const route: ApprovalRoute = {
      match: () => true,
      mode: 'human_required',
    };
    mgr.addRoute(route);

    const result = await mgr.startApproval('r1', 'a1', 0, makeProposal(), makePolicy(), { autoResolve: false });

    // No handler → no decision; run should suspend
    // Actually, with no handler it returns a denied decision with "No approval handler registered"
    // because shouldAutoResolve is false but auto_allow/auto_block are not matched,
    // and handlers.has('human_required') is false → shouldAutoResolve = false
    expect(result.decision).toBeUndefined();
    expect(result.request.mode).toBe('human_required');
  });

  it('auto_block resolves even with autoResolve: false', async () => {
    const mgr = new ApprovalManager();

    const route: ApprovalRoute = {
      match: () => true,
      mode: 'auto_block',
    };
    mgr.addRoute(route);

    const result = await mgr.startApproval('r1', 'a1', 0, makeProposal(), makePolicy(), { autoResolve: false });

    expect(result.decision).toBeDefined();
    expect(result.decision!.approved).toBe(false);
    expect(result.decision!.decidedBy).toBe('system:auto_block');
  });

  it('dual_approval handler resolves when registered', async () => {
    const mgr = new ApprovalManager();

    const route: ApprovalRoute = {
      match: () => true,
      mode: 'dual_approval',
    };
    mgr.addRoute(route);

    mgr.registerHandler('dual_approval', async (req) => ({
      requestId: req.id,
      approved: true,
      decidedBy: 'reviewer_a,reviewer_b',
      reason: 'Dual approved',
      decidedAt: Date.now(),
    }));

    const result = await mgr.startApproval('r1', 'a1', 0, makeProposal(), makePolicy(), { autoResolve: false });

    expect(result.decision).toBeDefined();
    expect(result.decision!.decidedBy).toBe('reviewer_a,reviewer_b');
  });

  it('resolve() works for pending requests', () => {
    const mgr = new ApprovalManager();

    // We need a pending request — call startApproval with no handler on human_required
    const route: ApprovalRoute = {
      match: () => true,
      mode: 'human_required',
    };
    mgr.addRoute(route);

    // Synchronous call via requestApproval that doesn't auto-resolve
    // Just startApproval and then resolve
    const startPromise = mgr.startApproval('r1', 'a1', 0, makeProposal(), makePolicy(), { autoResolve: false });

    startPromise.then((started) => {
      expect(started.decision).toBeUndefined();
      const pending = mgr.getPending();
      expect(pending).toHaveLength(1);

      const decision = mgr.resolve(started.request.id, true, 'test_user', 'Looks good');
      expect(decision).toBeDefined();
      expect(decision!.approved).toBe(true);
    });
  });
});
