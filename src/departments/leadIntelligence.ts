// ── 2. AI Lead Intelligence — tomorrow's customers, found today ────

import { randomUUID } from 'node:crypto';
import type { Customer, JourneyStage } from '../core/types.js';
import { AIEmployee } from './framework.js';

export interface StormEvent { date: string; hailInches: number; windMph: number; source: string; affectedZips: string[] }
export interface ProspectInput {
  address: string; city: string; state: string; zip: string;
  ownerName?: string; ownerPhone?: string; ownerEmail?: string;
  roofAgeYears?: number; propertyValue?: number;
  onDncRegistry: boolean; hasSolicitationRestriction: boolean;
}

export class LeadIntelligence extends AIEmployee {
  readonly department = 'lead_intelligence' as const;

  /** Score = storm severity × roof age × property profile × proximity. */
  score(p: ProspectInput, storm: StormEvent, neighborsWithJobs: number): number {
    const stormFactor = Math.min(1, (storm.hailInches / 2) * 0.6 + (storm.windMph / 100) * 0.4);
    const ageFactor = p.roofAgeYears == null ? 0.5 : Math.min(1, p.roofAgeYears / 20);
    const valueFactor = p.propertyValue == null ? 0.5 : Math.min(1, p.propertyValue / 400_000);
    const proximityBoost = Math.min(0.3, neighborsWithJobs * 0.1);
    return Math.round((stormFactor * 0.45 + ageFactor * 0.3 + valueFactor * 0.25 + proximityBoost) * 100);
  }

  /**
   * Daily generation: storm-matched prospects → enrich → COMPLIANCE
   * GATE → dedupe → CRM records → scored handoff to Inside Sales.
   * Non-compliant records are stored but flagged and NEVER handed off.
   */
  async generateProspects(storm: StormEvent, prospects: ProspectInput[], dailyCap = 50): Promise<{
    created: string[]; blocked: number; duplicates: number;
  }> {
    const created: string[] = [];
    let blocked = 0, duplicates = 0;

    for (const p of prospects) {
      if (created.length >= dailyCap) break;

      // Front compliance gate
      if (p.onDncRegistry || p.hasSolicitationRestriction) {
        blocked++;
        await this.store.appendAudit({
          actor: this.department, action: 'lead.compliance_blocked',
          after: { address: p.address, dnc: p.onDncRegistry, restriction: p.hasSolicitationRestriction },
        });
        continue;
      }

      // Dedupe against existing customers
      const existing = await this.store.findCustomerByContact(p.ownerPhone, p.ownerEmail);
      if (existing) { duplicates++; continue; }

      const customer: Customer = {
        id: randomUUID(),
        firstName: p.ownerName?.split(' ')[0],
        lastName: p.ownerName?.split(' ').slice(1).join(' ') || undefined,
        phone: p.ownerPhone,
        email: p.ownerEmail,
        consentSms: false,  // cold prospects: calls/mail until consent captured
        consentEmail: false,
        dnc: p.onDncRegistry,
        optedOut: false,
        archived: false,
      };
      await this.store.saveCustomer(customer);

      const score = this.score(p, storm, 0);
      const opp = {
        id: randomUUID(),
        customerId: customer.id,
        stage: 'new_lead' as JourneyStage,
        stageEnteredAt: this.now(),
        owningDepartment: this.department,
        path: 'undecided' as const,
        source: 'storm_match',
        score,
        nextAction: 'Enrich and qualify',
      };
      await this.store.saveOpportunity(opp);

      await this.decide(opp.id, `Scored prospect ${score}/100`, {
        storm: storm.date, hail: storm.hailInches, roofAge: p.roofAgeYears,
      }, 'Storm severity x roof age x property profile');

      await this.emit('lead.qualified', {
        opportunityId: opp.id, customerId: customer.id,
        payload: { score, storm: storm.date },
      });
      created.push(opp.id);
    }

    if (prospects.length > 0 && created.length === 0 && blocked + duplicates < prospects.length) {
      // anomaly: inputs existed but nothing came out — flag, don't stay silent
      await this.emit('ops.anomaly', { payload: { automation: 'lead_generation', note: 'zero prospects created from non-empty input' } });
    }

    return { created, blocked, duplicates };
  }
}
