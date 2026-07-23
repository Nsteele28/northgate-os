// ── 10. Warranty  11. Customer Success  12. Marketing ─────────────

import { AIEmployee } from './framework.js';

// ── Warranty Department — the relationship after the roof ──────────

export interface WarrantyRecord {
  opportunityId: string;
  customerId: string;
  manufacturer: string;
  registrationDeadline: Date;
  registeredAt?: Date;
  touchpoints: { type: '1yr_inspection' | '5yr_inspection' | 'seasonal'; due: Date; completedAt?: Date }[];
}

export class WarrantyDepartment extends AIEmployee {
  readonly department = 'warranty_department' as const;
  private records = new Map<string, WarrantyRecord>();

  async activate(opportunityId: string, customerId: string, manufacturer: string, registrationDeadlineDays: number): Promise<WarrantyRecord> {
    const now = this.now();
    const rec: WarrantyRecord = {
      opportunityId, customerId, manufacturer,
      registrationDeadline: new Date(now.getTime() + registrationDeadlineDays * 86_400_000),
      touchpoints: [
        { type: '1yr_inspection', due: new Date(now.getTime() + 365 * 86_400_000) },
        { type: '5yr_inspection', due: new Date(now.getTime() + 5 * 365 * 86_400_000) },
      ],
    };
    this.records.set(opportunityId, rec);
    await this.remember({ customerId, category: 'warranty', content: `${manufacturer} warranty activated` });
    return rec;
  }

  async register(opportunityId: string): Promise<void> {
    const rec = this.records.get(opportunityId);
    if (!rec) throw new Error('warranty record not found');
    rec.registeredAt = this.now();
    await this.store.appendAudit({
      actor: this.department, action: 'warranty.registered',
      entityId: opportunityId, after: { manufacturer: rec.manufacturer },
    });
  }

  /** Missing a registration deadline is a CRITICAL failure. */
  async sweepRegistrations(): Promise<string[]> {
    const critical: string[] = [];
    for (const rec of this.records.values()) {
      if (!rec.registeredAt && rec.registrationDeadline.getTime() - this.now().getTime() < 7 * 86_400_000) {
        critical.push(rec.opportunityId);
        await this.emit('ops.critical', {
          opportunityId: rec.opportunityId,
          payload: { note: `Manufacturer registration deadline approaching: ${rec.manufacturer}` },
        });
      }
    }
    return critical;
  }

  /** Warranty base is the referral flywheel. */
  async surfaceLifecycleOpportunities(customerId: string): Promise<void> {
    await this.emit('marketing.lifecycle_opportunity', {
      customerId, payload: { kind: 'warranty_base_referral' },
    });
  }
}

// ── Customer Success — the voice of the company ────────────────────

export type LifecycleMoment =
  | 'appointment_reminder' | 'crew_arrival' | 'material_delivery'
  | 'weather_delay' | 'production_update' | 'completion'
  | 'payment_confirmation' | 'warranty_info' | 'review_request' | 'referral_request';

const NEGATIVE = [/\bfrustrat/i, /\bconfus/i, /\bupset\b/i, /\bwhere is\b/i, /\bstill waiting\b/i, /\bno one (told|called)\b/i, /\bunhappy\b/i];

export class CustomerSuccess extends AIEmployee {
  readonly department = 'customer_success' as const;

  /** Personalized from memory; sounds like a person, not a pipeline. */
  async notify(customerId: string, opportunityId: string | undefined, moment: LifecycleMoment, facts: Record<string, unknown>): Promise<{ sent: boolean }> {
    const result = await this.speak(customerId, opportunityId, 'sms', moment, facts,
      moment === 'review_request' || moment === 'referral_request' ? 'sales' : 'transactional',
      moment === 'review_request' || moment === 'referral_request' ? 'existing customer relationship' : 'active job update');
    return { sent: result.sent };
  }

  /** Frustration reaches a human BEFORE it becomes a complaint. */
  async handleReply(customerId: string, body: string): Promise<'escalated' | 'handled'> {
    if (NEGATIVE.some(p => p.test(body))) {
      await this.store.createTask({
        owner: 'human',
        title: 'Customer sentiment escalation — reach out personally',
        detail: { customerId, body },
        createdBy: this.department,
      });
      return 'escalated';
    }
    await this.remember({ customerId, category: 'conversation_summary', content: `Reply: ${body.slice(0, 200)}` });
    return 'handled';
  }
}

// ── Marketing — every finished roof sells the next one ─────────────

export class Marketing extends AIEmployee {
  readonly department = 'marketing' as const;

  /** Reviews requested at the happiness peak: completed + paid. */
  async reviewRequestOnPaidInFull(customerId: string, opportunityId: string, satisfactionOk: boolean): Promise<'requested' | 'routed_to_human'> {
    if (!satisfactionOk) {
      await this.store.createTask({
        owner: 'human',
        title: 'Unhappy signal at completion — personal call before any review ask',
        detail: { customerId, opportunityId },
        createdBy: this.department,
      });
      return 'routed_to_human';
    }
    await this.speak(customerId, opportunityId, 'sms', 'review_request',
      { links: ['google', 'facebook'] }, 'sales', 'existing customer relationship');
    return 'requested';
  }

  /** Public content is drafted by AI, published only by humans. */
  async draftBeforeAfterPost(opportunityId: string, photos: string[], approvals: import('../core/approvals.js').ApprovalService): Promise<string> {
    const approval = await approvals.request({
      action: 'publish_public_content',
      opportunityId,
      requestedBy: this.department,
      summary: 'Before/after post drafted from production photos',
      workProduct: { photos, caption: '(drafted caption)' },
      reasoning: 'Completed job with strong visual transformation; homeowner consented to photos.',
      urgency: 'low',
    });
    return approval.id;
  }

  /** Neighborhood flywheel: completed jobs seed the next campaign. */
  async neighborhoodSignal(zip: string, completedJobsInZip: number, stormHistory: boolean): Promise<boolean> {
    if (completedJobsInZip >= 2 && stormHistory) {
      await this.emit('marketing.neighborhood_campaign', {
        payload: { zip, seedJobs: completedJobsInZip, angle: 'we_did_your_neighbors_roof' },
      });
      return true;
    }
    return false;
  }
}
