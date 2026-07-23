// ── Approval service: the single human gate queue ──────────────────
// AI departments call request(); execution of gated actions is only
// possible with an approved Approval whose action matches. The
// GateKeeper is how code paths prove they hold an approval.

import type { Store } from './store.js';
import type { Approval, Department, GatedAction } from './types.js';

const SLA_HOURS: Record<Approval['urgency'], number> = {
  low: 72, normal: 24, high: 4, critical: 1,
};

export class ApprovalRequiredError extends Error {
  constructor(action: GatedAction) {
    super(`APPROVAL_REQUIRED: '${action}' needs pending human approval — prepare the work product and call approvals.request()`);
  }
}

export class ApprovalNotGrantedError extends Error {
  constructor(action: GatedAction, status: string) {
    super(`APPROVAL_NOT_GRANTED: '${action}' approval is '${status}', not 'approved'`);
  }
}

export class ApprovalService {
  constructor(private store: Store, private now: () => Date = () => new Date()) {}

  /** AI prepares everything, presents the recommendation, and waits. */
  async request(params: {
    action: GatedAction;
    opportunityId?: string;
    requestedBy: Department;
    summary: string;
    workProduct: Record<string, unknown>;
    reasoning: string;
    consequences?: string;
    urgency?: Approval['urgency'];
  }): Promise<Approval> {
    const urgency = params.urgency ?? 'normal';
    const slaDue = new Date(this.now().getTime() + SLA_HOURS[urgency] * 3_600_000);
    const approval = await this.store.createApproval({ ...params, urgency, slaDue });
    await this.store.appendAudit({
      actor: params.requestedBy,
      action: `approval.requested:${params.action}`,
      entityTable: 'approvals',
      entityId: approval.id,
      after: { summary: params.summary, urgency },
    });
    await this.store.recordDecision({
      actor: params.requestedBy,
      opportunityId: params.opportunityId,
      decision: `Requested human approval for ${params.action}`,
      inputs: params.workProduct,
      reasoning: params.reasoning,
    });
    return approval;
  }

  /** Humans decide. A denial returns to the department with the note. */
  async decide(approvalId: string, decision: 'approved' | 'denied', humanIdentity: string, note?: string): Promise<Approval> {
    if (!humanIdentity?.trim()) {
      throw new Error('APPROVAL_GATE: decisions require a human identity');
    }
    const decided = await this.store.decideApproval(approvalId, decision, humanIdentity, note);
    await this.store.appendAudit({
      actor: humanIdentity,
      action: `approval.${decision}:${decided.action}`,
      entityTable: 'approvals',
      entityId: approvalId,
      after: { note },
    });
    return decided;
  }

  /**
   * Gate check before executing a gated action. Throws unless a
   * matching approval exists and is approved. Consumes nothing —
   * audit trail keeps the linkage.
   */
  async assertApproved(action: GatedAction, approvalId: string | undefined): Promise<Approval> {
    if (!approvalId) throw new ApprovalRequiredError(action);
    const approval = await this.store.getApproval(approvalId);
    if (!approval || approval.action !== action) throw new ApprovalRequiredError(action);
    if (approval.status !== 'approved') throw new ApprovalNotGrantedError(action, approval.status);
    return approval;
  }

  /** Overdue pending approvals, for Executive Ops escalation. */
  async overdue(): Promise<Approval[]> {
    const pending = await this.store.listPendingApprovals();
    const now = this.now().getTime();
    return pending.filter(a => a.slaDue && a.slaDue.getTime() < now);
  }
}
