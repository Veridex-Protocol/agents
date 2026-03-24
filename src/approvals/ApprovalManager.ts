/**
 * @module ApprovalManager
 * Approval workflow engine for high-risk agent actions.
 * Supports auto-allow, auto-block, human approval, and policy-based approval.
 */

import type { ActionProposal } from '../types/proposals';
import type { PolicyDecision } from '../types/policy';

// ── Approval Types ──

/** Approval modes for different risk levels. */
export type ApprovalMode = 'auto_allow' | 'auto_block' | 'human_required' | 'dual_approval' | 'policy_pack';

/** An approval request queued for decision. */
export interface ApprovalRequest {
  id: string;
  runId: string;
  agentId: string;
  turnIndex: number;
  proposal: ActionProposal;
  policyDecision: PolicyDecision;
  mode: ApprovalMode;
  reason: string;
  createdAt: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

/** Result of an approval decision. */
export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
  decidedBy: string;
  reason?: string;
  decidedAt: number;
  conditions?: Record<string, unknown>;
}

/** Approval handler — pluggable function that resolves an approval request. */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** Approval routing — maps risk conditions to approval modes. */
export interface ApprovalRoute {
  /** Match condition for this route. */
  match: (proposal: ActionProposal, policy: PolicyDecision) => boolean;
  /** Approval mode to use when matched. */
  mode: ApprovalMode;
  /** Optional timeout for the approval (ms). */
  timeoutMs?: number;
}

// ── Approval Manager ──

export class ApprovalManager {
  private routes: ApprovalRoute[] = [];
  private handlers = new Map<ApprovalMode, ApprovalHandler>();
  private pendingRequests = new Map<string, ApprovalRequest>();
  private decisions = new Map<string, ApprovalDecision>();
  private requestCounter = 0;

  constructor() {
    // Register default handlers
    this.handlers.set('auto_allow', async (req) => ({
      requestId: req.id,
      approved: true,
      decidedBy: 'system:auto_allow',
      reason: 'Auto-approved by policy',
      decidedAt: Date.now(),
    }));

    this.handlers.set('auto_block', async (req) => ({
      requestId: req.id,
      approved: false,
      decidedBy: 'system:auto_block',
      reason: req.policyDecision.reasons.join('; ') || 'Blocked by policy',
      decidedAt: Date.now(),
    }));
  }

  /** Add an approval route. Routes are evaluated in order. */
  addRoute(route: ApprovalRoute): void {
    this.routes.push(route);
  }

  /** Register a handler for an approval mode (e.g., human_required, dual_approval). */
  registerHandler(mode: ApprovalMode, handler: ApprovalHandler): void {
    this.handlers.set(mode, handler);
  }

  /** Clear all routes. */
  clearRoutes(): void {
    this.routes = [];
  }

  /**
   * Determine which approval mode applies and process the request.
   * Returns the approval decision.
   */
  async requestApproval(
    runId: string,
    agentId: string,
    turnIndex: number,
    proposal: ActionProposal,
    policyDecision: PolicyDecision,
  ): Promise<ApprovalDecision> {
    // Determine approval mode from routes
    let mode: ApprovalMode = 'auto_allow';

    // Default escalation: blocked → auto_block, escalated → human_required
    if (policyDecision.verdict === 'block') {
      mode = 'auto_block';
    } else if (policyDecision.verdict === 'escalate') {
      mode = 'human_required';
    }

    // Check custom routes (override defaults)
    for (const route of this.routes) {
      if (route.match(proposal, policyDecision)) {
        mode = route.mode;
        break;
      }
    }

    const request: ApprovalRequest = {
      id: `apr_${++this.requestCounter}_${Date.now()}`,
      runId,
      agentId,
      turnIndex,
      proposal,
      policyDecision,
      mode,
      reason: policyDecision.reasons.join('; ') || 'Approval required',
      createdAt: Date.now(),
    };

    this.pendingRequests.set(request.id, request);

    // Get handler for this mode
    const handler = this.handlers.get(mode);
    if (!handler) {
      // No handler registered — default to block
      const decision: ApprovalDecision = {
        requestId: request.id,
        approved: false,
        decidedBy: 'system:no_handler',
        reason: `No approval handler registered for mode '${mode}'`,
        decidedAt: Date.now(),
      };
      this.pendingRequests.delete(request.id);
      this.decisions.set(request.id, decision);
      return decision;
    }

    const decision = await handler(request);
    this.pendingRequests.delete(request.id);
    this.decisions.set(request.id, decision);
    return decision;
  }

  /** Get all pending approval requests. */
  getPending(): ApprovalRequest[] {
    return [...this.pendingRequests.values()];
  }

  /** Get a specific pending request by ID. */
  getPendingById(id: string): ApprovalRequest | undefined {
    return this.pendingRequests.get(id);
  }

  /** Get all past decisions. */
  getDecisions(): ApprovalDecision[] {
    return [...this.decisions.values()];
  }

  /** Get a decision by request ID. */
  getDecision(requestId: string): ApprovalDecision | undefined {
    return this.decisions.get(requestId);
  }

  /** Manually resolve a pending request (for external approval UIs). */
  resolve(requestId: string, approved: boolean, decidedBy: string, reason?: string): ApprovalDecision | null {
    const request = this.pendingRequests.get(requestId);
    if (!request) return null;

    const decision: ApprovalDecision = {
      requestId,
      approved,
      decidedBy,
      reason,
      decidedAt: Date.now(),
    };

    this.pendingRequests.delete(requestId);
    this.decisions.set(requestId, decision);
    return decision;
  }

  /** Clear all state. */
  clear(): void {
    this.pendingRequests.clear();
    this.decisions.clear();
    this.requestCounter = 0;
  }
}
