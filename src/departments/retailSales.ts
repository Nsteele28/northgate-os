// ── 7. AI Retail Sales Coordinator — from yes to signed ────────────

import type { ApprovalService } from '../core/approvals.js';
import type { Store } from '../core/store.js';
import type { Brain, CommsService } from './framework.js';
import { AIEmployee } from './framework.js';

export interface ProposalDraft {
  opportunityId: string;
  options: { tier: 'good' | 'better' | 'best'; lineItems: { code: string; qty: number; unitPrice: number }[] }[];
  listPrice: number;
  finalPrice: number;
  financingMonthly?: number;
}

export class RetailSales extends AIEmployee {
  readonly department = 'retail_sales' as const;

  constructor(store: Store, comms: CommsService, brain: Brain, private approvals: ApprovalService, now?: () => Date) {
    super(store, comms, brain, now);
  }

  /** Prices come from the price book. Building at list needs no gate. */
  buildProposal(opportunityId: string, priceBook: Map<string, number>, scope: { code: string; qty: number }[]): ProposalDraft {
    const lineItems = scope.map(s => {
      const unitPrice = priceBook.get(s.code);
      if (unitPrice == null) throw new Error(`PRICE_BOOK: unknown item ${s.code} — humans maintain the price book`);
      return { code: s.code, qty: s.qty, unitPrice };
    });
    const listPrice = lineItems.reduce((sum, li) => sum + li.qty * li.unitPrice, 0);
    return {
      opportunityId,
      options: [{ tier: 'better', lineItems }],
      listPrice,
      finalPrice: listPrice,
      financingMonthly: Math.round(listPrice / 120),
    };
  }

  /** ANY deviation from list price is a human decision. */
  async requestDiscountApproval(draft: ProposalDraft, proposedPrice: number, customerContext: string): Promise<string> {
    const approval = await this.approvals.request({
      action: 'approve_discount',
      opportunityId: draft.opportunityId,
      requestedBy: this.department,
      summary: `Discount request: $${draft.listPrice} → $${proposedPrice} (${Math.round((1 - proposedPrice / draft.listPrice) * 100)}% off)`,
      workProduct: { listPrice: draft.listPrice, proposedPrice, marginImpact: draft.listPrice - proposedPrice },
      reasoning: customerContext,
      consequences: 'Approved: revised proposal goes out. Denied: hold at list with value framing.',
      urgency: 'high',
    });
    return approval.id;
  }

  async applyApprovedDiscount(draft: ProposalDraft, proposedPrice: number, approvalId: string): Promise<ProposalDraft> {
    const approval = await this.approvals.assertApproved('approve_discount', approvalId);
    return { ...draft, finalPrice: proposedPrice, /* discountApprovedBy: */ ...( { discountApprovedBy: approval.decidedBy } as object) };
  }

  /** Contract send is human-gated even at list price. */
  async requestContractSendApproval(opportunityId: string, contractSummary: Record<string, unknown>): Promise<string> {
    const approval = await this.approvals.request({
      action: 'send_contract',
      opportunityId,
      requestedBy: this.department,
      summary: 'Send contract for e-signature',
      workProduct: contractSummary,
      reasoning: 'Proposal accepted by customer; contract mirrors approved proposal with standard terms.',
      consequences: 'Approved: e-sign envelope sent. Denied: returned with note for revision.',
      urgency: 'high',
    });
    return approval.id;
  }

  async sendContract(opportunityId: string, approvalId: string): Promise<void> {
    await this.approvals.assertApproved('send_contract', approvalId);
    const opp = await this.store.getOpportunity(opportunityId);
    if (!opp) throw new Error('opportunity not found');
    // (e-sign adapter dispatches envelope here)
    await this.speak(opp.customerId, opp.id, 'email', 'contract_delivery',
      { instructions: 'review and sign electronically' }, 'transactional', 'contract they requested');
  }

  /** Deposit verified + signed → production. */
  async contractSigned(opportunityId: string, depositVerified: boolean): Promise<void> {
    if (!depositVerified) {
      await this.store.createTask({
        opportunityId, owner: this.department,
        title: 'Signed but deposit not cleared — follow up payment',
        detail: {}, createdBy: this.department,
      });
      return;
    }
    await this.emit('contract.signed_deposit_verified', { opportunityId, payload: {} });
  }

  /** Full follow-up exhausted → nurture (never AI-closed). */
  async proposalWentCold(opportunityId: string): Promise<void> {
    await this.emit('proposal.gone_cold', { opportunityId, payload: {} });
  }
}
