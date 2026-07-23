// ── 13. AI Executive Operations — watches the departments ──────────
// Detect → Repair → Escalate. The prime directive: no silent failure.

import type { ApprovalService } from '../core/approvals.js';
import type { Store } from '../core/store.js';
import type { OperationsDirector } from '../director/router.js';
import type { Department, HealthRecord } from '../core/types.js';

export type Severity = 'critical' | 'degraded' | 'hygiene';

export interface Escalation {
  severity: Severity;
  automationKey?: string;
  what: string;
  whoAffected: string;
  whatWasTried: string;
  recommendedAction: string;
}

export class ExecutiveOps {
  /** Repairs attempted before escalation, per failure class. */
  static MAX_RETRIES = 3;

  private escalations: Escalation[] = [];

  constructor(
    private store: Store,
    private director: OperationsDirector,
    private approvals: ApprovalService,
    private notifyManagement: (e: Escalation) => Promise<void>,
    private now: () => Date = () => new Date(),
  ) {}

  /** Heartbeat from a running automation. */
  async heartbeat(automationKey: string, department: Department, ok: boolean, error?: string): Promise<void> {
    const existing = await this.store.getHealth(automationKey);
    const rec: HealthRecord = existing ?? {
      automationKey, department, status: 'green',
      consecutiveFailures: 0, heartbeatExpectedEveryMs: 15 * 60_000,
    };
    rec.lastHeartbeat = this.now();
    if (ok) {
      rec.lastSuccess = this.now();
      rec.consecutiveFailures = 0;
      rec.status = 'green';
      rec.lastError = undefined;
    } else {
      rec.consecutiveFailures++;
      rec.lastError = error;
      rec.status = rec.consecutiveFailures >= ExecutiveOps.MAX_RETRIES ? 'red' : 'yellow';
    }
    await this.store.upsertHealth(rec);

    if (rec.status === 'red') {
      await this.escalate({
        severity: 'critical',
        automationKey,
        what: `${automationKey} failing: ${error}`,
        whoAffected: `department ${department}`,
        whatWasTried: `${rec.consecutiveFailures} consecutive attempts`,
        recommendedAction: 'Check integration credentials/status; automation is paused from customer-facing sends',
      });
    }
  }

  /**
   * The sweep — run on a schedule. Detects: heartbeat gaps (a failure
   * that reports nothing is itself detectable), stuck opportunities,
   * overdue approvals, unprocessed event backlog.
   */
  async sweep(): Promise<{ escalations: Escalation[]; stuckCount: number; repairedEvents: number }> {
    const now = this.now().getTime();

    // 1. Heartbeat gaps
    for (const rec of await this.store.listHealth()) {
      if (rec.lastHeartbeat && now - rec.lastHeartbeat.getTime() > rec.heartbeatExpectedEveryMs * 2) {
        rec.status = 'red';
        await this.store.upsertHealth(rec);
        await this.escalate({
          severity: 'critical',
          automationKey: rec.automationKey,
          what: `${rec.automationKey} stopped reporting (last heartbeat ${rec.lastHeartbeat.toISOString()})`,
          whoAffected: `department ${rec.department}`,
          whatWasTried: 'heartbeat monitoring',
          recommendedAction: 'Automation may have crashed — restart and check logs',
        });
      }
    }

    // 2. Stuck opportunities (dwell-time violations)
    const stuck = await this.director.sweepStuck();
    for (const opp of stuck) {
      await this.escalate({
        severity: opp.stage === 'emergency' ? 'critical' : 'degraded',
        what: `Opportunity ${opp.id} stuck in ${opp.stage} since ${opp.stageEnteredAt.toISOString()}`,
        whoAffected: `customer ${opp.customerId}`,
        whatWasTried: 'stuck-task created for owning department',
        recommendedAction: opp.nextAction ?? 'Review record',
      });
    }

    // 3. Overdue approvals
    for (const approval of await this.approvals.overdue()) {
      await this.escalate({
        severity: approval.urgency === 'critical' || approval.urgency === 'high' ? 'critical' : 'degraded',
        what: `Approval overdue: ${approval.summary}`,
        whoAffected: approval.opportunityId ? `opportunity ${approval.opportunityId}` : 'company',
        whatWasTried: `SLA notification (due ${approval.slaDue?.toISOString()})`,
        recommendedAction: `Decide approval ${approval.id} (${approval.action})`,
      });
    }

    // 4. Event backlog repair: drain anything unprocessed
    const repairedEvents = await this.director.drain();

    return { escalations: [...this.escalations], stuckCount: stuck.length, repairedEvents };
  }

  private async escalate(e: Escalation): Promise<void> {
    this.escalations.push(e);
    await this.store.appendAudit({
      actor: 'executive_operations',
      action: `escalation.${e.severity}`,
      after: e,
    });
    if (e.severity === 'critical') {
      await this.notifyManagement(e); // pages immediately
    }
    // degraded → daily digest; hygiene → weekly review (both read from audit)
  }

  /** Dashboard data: single call returns the health board. */
  async healthBoard() {
    const health = await this.store.listHealth();
    const pendingApprovals = await this.store.listPendingApprovals();
    const openTasks = await this.store.listOpenTasks();
    return {
      automations: health.map(h => ({ key: h.automationKey, status: h.status, lastError: h.lastError })),
      pendingApprovals: pendingApprovals.length,
      openTasks: openTasks.length,
      escalations: this.escalations.length,
    };
  }
}
