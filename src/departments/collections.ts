// ── 9. AI Collections Manager — polite, persistent, precise ────────

import type { ApprovalService } from '../core/approvals.js';
import type { Store } from '../core/store.js';
import type { Brain, CommsService } from './framework.js';
import { AIEmployee } from './framework.js';

export interface InvoiceState {
  opportunityId: string;
  amount: number;
  payments: { amount: number; at: Date }[];
  dueDate: Date;
  remindersSent: ('friendly' | 'firm' | 'past_due')[];
}

export class CollectionsManager extends AIEmployee {
  readonly department = 'collections_manager' as const;
  private invoices = new Map<string, InvoiceState>();

  constructor(store: Store, comms: CommsService, brain: Brain, private approvals: ApprovalService, now?: () => Date) {
    super(store, comms, brain, now);
  }

  generateInvoice(opportunityId: string, contractAmount: number, approvedSupplements: number, dueDate: Date): InvoiceState {
    const inv: InvoiceState = {
      opportunityId,
      amount: contractAmount + approvedSupplements,
      payments: [],
      dueDate,
      remindersSent: [],
    };
    this.invoices.set(opportunityId, inv);
    return inv;
  }

  balance(opportunityId: string): number {
    const inv = this.mustGet(opportunityId);
    return inv.amount - inv.payments.reduce((s, p) => s + p.amount, 0);
  }

  /** Payments reconcile in real time; zero balance fires the handoff. */
  async recordPayment(opportunityId: string, amount: number): Promise<number> {
    const inv = this.mustGet(opportunityId);
    inv.payments.push({ amount, at: this.now() });
    const remaining = this.balance(opportunityId);
    const opp = await this.store.getOpportunity(opportunityId);
    if (opp) {
      await this.speak(opp.customerId, opp.id, 'sms', 'payment_confirmation',
        { received: amount, remaining }, 'transactional', 'their payment');
    }
    if (remaining <= 0) {
      await this.emit('invoice.paid_in_full', { opportunityId, payload: { total: inv.amount } });
    }
    return remaining;
  }

  /** Reminder ladder — always accurate to the penny. */
  async sendReminder(opportunityId: string): Promise<'friendly' | 'firm' | 'past_due' | 'paid'> {
    const inv = this.mustGet(opportunityId);
    const bal = this.balance(opportunityId);
    if (bal <= 0) return 'paid';
    const overdueDays = Math.floor((this.now().getTime() - inv.dueDate.getTime()) / 86_400_000);
    const tier = overdueDays <= 0 ? 'friendly' : overdueDays <= 14 ? 'firm' : 'past_due';
    const opp = await this.store.getOpportunity(opportunityId);
    if (opp) {
      await this.speak(opp.customerId, opp.id, 'sms', `payment_reminder_${tier}`,
        { balance: bal, due: inv.dueDate.toISOString().slice(0, 10) },
        'transactional', 'invoice on their contract');
    }
    inv.remindersSent.push(tier);
    return tier;
  }

  /**
   * Legal escalation is PREPARED by the AI, TRIGGERED only by a human.
   * The AI never waives balances or negotiates settlements.
   */
  async prepareLegalEscalation(opportunityId: string): Promise<string> {
    const bal = this.balance(opportunityId);
    const inv = this.mustGet(opportunityId);
    const approval = await this.approvals.request({
      action: 'initiate_legal_collection',
      opportunityId,
      requestedBy: this.department,
      summary: `Legal collection recommended: $${bal} outstanding, ${inv.remindersSent.length} reminders sent`,
      workProduct: {
        balance: bal,
        timeline: inv.remindersSent,
        draftedNotice: 'NOTICE OF INTENT TO FILE LIEN (draft — human review required)',
      },
      reasoning: 'Full reminder ladder exhausted; no payment plan engagement.',
      consequences: 'Approved: notice sent / lien process starts. Denied: continue soft collection.',
      urgency: 'normal',
    });
    return approval.id;
  }

  async requestBalanceWaiver(opportunityId: string, waiveAmount: number, customerSituation: string): Promise<string> {
    const approval = await this.approvals.request({
      action: 'waive_balance',
      opportunityId,
      requestedBy: this.department,
      summary: `Customer requests $${waiveAmount} adjustment`,
      workProduct: { balance: this.balance(opportunityId), waiveAmount },
      reasoning: customerSituation,
      urgency: 'normal',
    });
    return approval.id;
  }

  private mustGet(id: string): InvoiceState {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error(`invoice for ${id} not found`);
    return inv;
  }
}
