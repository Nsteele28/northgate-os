// ── 6. AI Insurance Coordinator — airtight packets, honest claims ──

import type { ApprovalService } from '../core/approvals.js';
import type { Brain, CommsService } from './framework.js';
import { AIEmployee } from './framework.js';
import type { Store } from '../core/store.js';

export interface StormVerification {
  verified: boolean;
  eventDate?: string;
  hailInches?: number;
  windMph?: number;
  sources: string[];
  failureReason?: string;
}

export interface EvidencePacket {
  opportunityId: string;
  carrier: string;
  stormVerification: StormVerification;
  photos: { url: string; label: string; damagePoint?: string }[];
  measurements: Record<string, unknown>;
  technicianSummary: string;
  carrierFormatting: string;
}

export class UnsupportedClaimError extends Error {
  constructor(reason: string) {
    super(`UNSUPPORTED_CLAIM: ${reason} — Northgate never files unsupported claims; route to retail options`);
  }
}

export class InsuranceCoordinator extends AIEmployee {
  readonly department = 'insurance_coordinator' as const;

  constructor(store: Store, comms: CommsService, brain: Brain, private approvals: ApprovalService, now?: () => Date) {
    super(store, comms, brain, now);
  }

  /**
   * Storm verification against real weather data. This is the honesty
   * gate: no verified storm ⇒ no claim path, period. The verification
   * object records its sources so any packet is auditable.
   */
  verifyStorm(propertyStormHistory: { date: string; hailInches: number; windMph: number; source: string }[], damageDate?: string): StormVerification {
    const candidates = propertyStormHistory.filter(s => s.hailInches >= 0.75 || s.windMph >= 58);
    if (!candidates.length) {
      return { verified: false, sources: [], failureReason: 'No qualifying weather event at this property' };
    }
    const best = candidates.sort((a, b) => b.hailInches - a.hailInches)[0]!;
    return {
      verified: true,
      eventDate: best.date,
      hailInches: best.hailInches,
      windMph: best.windMph,
      sources: candidates.map(c => c.source),
    };
  }

  /** Build the packet. Throws if the storm doesn't verify. */
  async buildPacket(params: {
    opportunityId: string;
    carrier: string;
    stormHistory: { date: string; hailInches: number; windMph: number; source: string }[];
    photos: { url: string; label: string; damagePoint?: string }[];
    measurements: Record<string, unknown>;
    technicianSummary: string;
  }): Promise<EvidencePacket> {
    const verification = this.verifyStorm(params.stormHistory);
    if (!verification.verified) {
      const opp = await this.store.getOpportunity(params.opportunityId);
      await this.decide(params.opportunityId, 'Claim path stopped: storm not verified',
        { stormHistory: params.stormHistory }, verification.failureReason!);
      if (opp) {
        // honest retail fallback — customer still has a roof problem
        await this.emit('path.retail_selected', {
          opportunityId: opp.id, customerId: opp.customerId,
          payload: { reason: 'no verifiable storm event' },
        });
      }
      throw new UnsupportedClaimError(verification.failureReason!);
    }

    const packet: EvidencePacket = {
      opportunityId: params.opportunityId,
      carrier: params.carrier,
      stormVerification: verification,
      photos: params.photos,
      measurements: params.measurements,
      technicianSummary: params.technicianSummary,
      carrierFormatting: `formatted-for:${params.carrier}`,
    };
    await this.decide(params.opportunityId, 'Evidence packet built',
      { carrier: params.carrier, photoCount: params.photos.length, storm: verification.eventDate },
      'Storm verified from real weather data; packet assembled to carrier preferences');
    return packet;
  }

  /**
   * Submission = human approval gate. The AI prepares everything,
   * presents the recommendation, and waits. Returns the approval id;
   * executeSubmission() can only run once a human approves.
   */
  async requestSubmissionApproval(packet: EvidencePacket): Promise<string> {
    const approval = await this.approvals.request({
      action: 'submit_insurance_packet',
      opportunityId: packet.opportunityId,
      requestedBy: this.department,
      summary: `Submit ${packet.carrier} claim packet (storm ${packet.stormVerification.eventDate}, ${packet.photos.length} photos)`,
      workProduct: packet as unknown as Record<string, unknown>,
      reasoning: `Verified ${packet.stormVerification.hailInches}" hail / ${packet.stormVerification.windMph}mph wind on ${packet.stormVerification.eventDate} (sources: ${packet.stormVerification.sources.join(', ')}); documented damage consistent with event.`,
      consequences: 'Approved: claim filed with carrier. Denied: packet returns for revision or retail path.',
      urgency: 'high',
    });
    return approval.id;
  }

  async executeSubmission(packet: EvidencePacket, approvalId: string): Promise<void> {
    await this.approvals.assertApproved('submit_insurance_packet', approvalId);
    // (integration adapter files with carrier here)
    await this.emit('claim.packet_approved_and_submitted', {
      opportunityId: packet.opportunityId,
      payload: { carrier: packet.carrier, approvalId },
    });
  }

  /** Claim outcome handlers — both directions route, nothing dead-ends. */
  async claimApproved(opportunityId: string, approvedScope: Record<string, unknown>): Promise<void> {
    await this.emit('claim.approved', { opportunityId, payload: { approvedScope } });
  }
  async claimDenied(opportunityId: string, reason: string): Promise<void> {
    await this.decide(opportunityId, 'Claim denied by carrier', { reason }, 'Routing to honest retail fallback');
    await this.emit('claim.denied', { opportunityId, payload: { reason } });
  }

  /** Supplements: legitimate missed scope only, human-gated. */
  async requestSupplementApproval(opportunityId: string, missedItems: { item: string; justification: string; amount: number }[]): Promise<string> {
    const approval = await this.approvals.request({
      action: 'file_supplement',
      opportunityId,
      requestedBy: this.department,
      summary: `File supplement: ${missedItems.length} legitimately missed scope items ($${missedItems.reduce((s, i) => s + i.amount, 0)})`,
      workProduct: { missedItems },
      reasoning: missedItems.map(i => `${i.item}: ${i.justification}`).join('; '),
      urgency: 'normal',
    });
    return approval.id;
  }
}
