// ── 3. AI Inside Sales — every lead worked forever ─────────────────

import { AIEmployee } from './framework.js';

/** Follow-up cadence in hours after the previous touch, per phase. */
export const CADENCE = {
  fresh: [0, 24, 72, 168, 336],          // first two weeks
  aging: [720, 1440],                    // monthly-ish
  nurture: [2160],                       // quarterly touch, forever
};

export class InsideSales extends AIEmployee {
  readonly department = 'inside_sales' as const;

  /** Work a lead: outreach touch through the compliant comms path. */
  async outreachTouch(opportunityId: string, touchNumber: number): Promise<{ sent: boolean; blockedReason?: string }> {
    const opp = await this.store.getOpportunity(opportunityId);
    if (!opp) throw new Error(`opportunity ${opportunityId} not found`);
    const result = await this.speak(
      opp.customerId, opp.id, 'sms',
      'outreach_touch',
      { touchNumber, context: 'storm damage inspection offer' },
      'sales', 'prior-express-consent or established relationship',
    );
    await this.decide(opp.id, `Outreach touch #${touchNumber}: ${result.sent ? 'sent' : 'blocked'}`,
      { touchNumber }, result.sent ? 'Cadence step executed' : `Compliance: ${result.blockedReason}`);
    return result;
  }

  /** Qualify + book: emits inspection.booked; director routes. */
  async bookInspection(opportunityId: string, slot: Date, qualification: {
    roofAgeYears?: number; damageObserved?: string; carrier?: string; timeline?: string;
  }): Promise<void> {
    const opp = await this.store.getOpportunity(opportunityId);
    if (!opp) throw new Error(`opportunity ${opportunityId} not found`);

    for (const [k, v] of Object.entries(qualification)) {
      if (v != null) {
        await this.remember({
          customerId: opp.customerId,
          category: k === 'carrier' ? 'insurance_history' : 'conversation_summary',
          content: `${k}: ${v}`,
        });
      }
    }
    await this.emit('inspection.booked', {
      opportunityId, customerId: opp.customerId,
      payload: { slot: slot.toISOString(), qualification },
    });
    await this.speak(opp.customerId, opp.id, 'sms', 'booking_confirmation',
      { when: slot.toISOString() }, 'transactional', 'appointment they requested');
  }

  /**
   * Leads are never closed by the AI. Exhausted cadences go to
   * nurture — only humans (or legal opt-out) permanently close.
   */
  async moveToNurture(opportunityId: string, reason: string): Promise<void> {
    const opp = await this.store.getOpportunity(opportunityId);
    if (!opp) return;
    await this.decide(opp.id, 'Moved to nurture (never closed)', { reason },
      'Cadence exhausted without a no — long-cycle nurture with storm-triggered reactivation');
    await this.emit('proposal.gone_cold', { opportunityId, customerId: opp.customerId, payload: { reason } });
  }

  /** No-show recovery: warm, immediate, then decaying. */
  async recoverNoShow(opportunityId: string): Promise<void> {
    const opp = await this.store.getOpportunity(opportunityId);
    if (!opp) return;
    await this.emit('inspection.no_show', { opportunityId, customerId: opp.customerId, payload: {} });
    await this.speak(opp.customerId, opp.id, 'sms', 'no_show_recovery',
      { tone: 'life happens', offer: 'easy reschedule link' },
      'transactional', 'missed appointment they booked');
  }
}
