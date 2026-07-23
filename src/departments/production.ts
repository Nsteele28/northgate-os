// ── 8. AI Production Manager — signed to shingled ──────────────────

import type { ApprovalService } from '../core/approvals.js';
import type { Store } from '../core/store.js';
import type { Brain, CommsService } from './framework.js';
import { AIEmployee } from './framework.js';

export interface ProductionState {
  opportunityId: string;
  depositVerified: boolean;
  materialsOrdered: boolean;
  materialsDelivered: boolean;
  crewScheduled: boolean;
  dumpsterScheduled: boolean;
  permitStatus: 'not_started' | 'applied' | 'approved' | 'not_required';
  scheduledStart?: Date;
  weatherHold?: string;
  punchList: string[];
  walkthroughPassed?: boolean;
}

export class ProductionManager extends AIEmployee {
  readonly department = 'production_manager' as const;
  private jobs = new Map<string, ProductionState>();

  constructor(
    store: Store, comms: CommsService, brain: Brain,
    private approvals: ApprovalService,
    private materialLimitUsd: number,
    now?: () => Date,
  ) {
    super(store, comms, brain, now);
  }

  startJob(opportunityId: string, depositVerified: boolean): ProductionState {
    if (!depositVerified) throw new Error('PRODUCTION_GATE: deposit must be verified before any ordering');
    const state: ProductionState = {
      opportunityId, depositVerified,
      materialsOrdered: false, materialsDelivered: false,
      crewScheduled: false, dumpsterScheduled: false,
      permitStatus: 'not_started', punchList: [],
    };
    this.jobs.set(opportunityId, state);
    return state;
  }

  /** Material orders above the configured limit require human approval. */
  async orderMaterials(opportunityId: string, order: { supplier: string; amountUsd: number; items: unknown[] }, approvalId?: string): Promise<void> {
    const job = this.mustGet(opportunityId);
    if (order.amountUsd > this.materialLimitUsd) {
      await this.approvals.assertApproved('order_materials_above_limit', approvalId);
    }
    job.materialsOrdered = true;
    await this.decide(opportunityId, `Materials ordered from ${order.supplier} ($${order.amountUsd})`,
      { order: { supplier: order.supplier, amountUsd: order.amountUsd } },
      order.amountUsd > this.materialLimitUsd ? 'Above limit — human approved' : 'Within configured limit');
  }

  async requestLargeOrderApproval(opportunityId: string, order: { supplier: string; amountUsd: number; items: unknown[] }): Promise<string> {
    const approval = await this.approvals.request({
      action: 'order_materials_above_limit',
      opportunityId,
      requestedBy: this.department,
      summary: `Material order $${order.amountUsd} from ${order.supplier} (limit: $${this.materialLimitUsd})`,
      workProduct: order as unknown as Record<string, unknown>,
      reasoning: 'Order exceeds configured spend limit; scope matches contract.',
      urgency: 'high',
    });
    return approval.id;
  }

  /** Weather watch: proactive reschedule BEFORE the customer wonders. */
  async weatherCheck(opportunityId: string, forecast: { date: string; rainChance: number; windMph: number }[]): Promise<boolean> {
    const job = this.mustGet(opportunityId);
    if (!job.scheduledStart) return false;
    const bad = forecast.find(f => f.rainChance > 60 || f.windMph > 25);
    if (bad) {
      job.weatherHold = bad.date;
      const opp = await this.store.getOpportunity(opportunityId);
      if (opp) {
        await this.speak(opp.customerId, opp.id, 'sms', 'weather_delay_notice',
          { reason: `forecast ${bad.rainChance}% rain / ${bad.windMph}mph wind`, promise: 'new date within 24h' },
          'transactional', 'active job update');
      }
      return true;
    }
    return false;
  }

  /** All prerequisites → installing. Missing ones raise SPECIFIC alerts. */
  async checkReadyToInstall(opportunityId: string): Promise<{ ready: boolean; missing: string[] }> {
    const job = this.mustGet(opportunityId);
    const missing: string[] = [];
    if (!job.materialsDelivered) missing.push('materials not delivered');
    if (!job.crewScheduled) missing.push('crew not scheduled');
    if (!job.dumpsterScheduled) missing.push('dumpster not scheduled');
    if (job.permitStatus !== 'approved' && job.permitStatus !== 'not_required') missing.push(`permit ${job.permitStatus}`);
    if (job.weatherHold) missing.push(`weather hold ${job.weatherHold}`);

    if (missing.length) {
      await this.store.createTask({
        opportunityId, owner: this.department,
        title: `Install blocked: ${missing.join('; ')}`,
        detail: { missing }, createdBy: this.department,
      });
      return { ready: false, missing };
    }
    await this.emit('production.ready_to_install', { opportunityId, payload: {} });
    return { ready: true, missing: [] };
  }

  /** Completion requires punch list cleared + walkthrough passed. */
  async verifyCompletion(opportunityId: string): Promise<boolean> {
    const job = this.mustGet(opportunityId);
    if (job.punchList.length > 0 || job.walkthroughPassed !== true) {
      await this.store.createTask({
        opportunityId, owner: this.department,
        title: `Completion blocked: ${job.punchList.length} punch items, walkthrough ${job.walkthroughPassed ? 'passed' : 'pending'}`,
        detail: { punchList: job.punchList }, createdBy: this.department,
      });
      return false;
    }
    await this.emit('production.completed_walkthrough_passed', { opportunityId, payload: {} });
    return true;
  }

  getJob(opportunityId: string) { return this.jobs.get(opportunityId); }
  private mustGet(id: string): ProductionState {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`production job ${id} not found`);
    return j;
  }
}
