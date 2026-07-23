// ── Compliance engine: consent, DNC, quiet hours, opt-out ──────────
// Checked at SEND TIME on every outbound message (the back gate);
// Lead Intelligence also checks at list-build time (the front gate).

import type { Store } from './store.js';
import type { Channel, Customer, OutboundMessage } from './types.js';

export interface ComplianceConfig {
  quietHoursStart: number; // hour 0-23, company timezone
  quietHoursEnd: number;
  /** max outbound marketing/sales messages per customer per week */
  weeklyFrequencyCap: number;
}

export const DEFAULT_COMPLIANCE: ComplianceConfig = {
  quietHoursStart: 21,
  quietHoursEnd: 8,
  weeklyFrequencyCap: 5,
};

export class ComplianceBlockedError extends Error {
  constructor(public reason: string) {
    super(`COMPLIANCE_BLOCKED: ${reason}`);
  }
}

const OPT_OUT_PATTERNS = [
  /\bstop\b/i, /\bunsubscribe\b/i, /\bremove me\b/i, /\bdon'?t (text|call|contact|message) me\b/i,
  /\bopt.?out\b/i, /\btake me off\b/i, /\bquit\b/i, /\bstop texting\b/i, /\bleave me alone\b/i,
];

export function looksLikeOptOut(message: string): boolean {
  return OPT_OUT_PATTERNS.some(p => p.test(message));
}

export class ComplianceEngine {
  constructor(
    private store: Store,
    private config: ComplianceConfig = DEFAULT_COMPLIANCE,
    private now: () => Date = () => new Date(),
  ) {}

  /**
   * The send-time gate. Throws ComplianceBlockedError if this message
   * may not be sent. Transactional lifecycle messages (appointment
   * reminders, production updates for an active job) ride on the
   * business relationship; marketing/sales messages require consent.
   */
  async assertSendable(msg: OutboundMessage, kind: 'sales' | 'transactional'): Promise<Customer> {
    const customer = await this.store.getCustomer(msg.customerId);
    if (!customer) throw new ComplianceBlockedError('unknown customer');

    if (customer.optedOut) {
      throw new ComplianceBlockedError('customer opted out — permanent, all channels');
    }
    if (kind === 'sales') {
      if (customer.dnc) throw new ComplianceBlockedError('customer on DNC registry');
      if (msg.channel === 'sms' && !customer.consentSms) {
        throw new ComplianceBlockedError('no SMS consent for sales messaging');
      }
      if (msg.channel === 'email' && !customer.consentEmail) {
        throw new ComplianceBlockedError('no email consent for sales messaging');
      }
      if (this.inQuietHours()) {
        throw new ComplianceBlockedError('quiet hours — queue for morning');
      }
    }
    return customer;
  }

  inQuietHours(): boolean {
    const hour = this.now().getHours();
    const { quietHoursStart: s, quietHoursEnd: e } = this.config;
    return s > e ? hour >= s || hour < e : hour >= s && hour < e;
  }

  /**
   * Instant, permanent, cross-channel opt-out. No department may
   * reverse this; only the customer re-consenting in writing can.
   */
  async processOptOut(customerId: string, viaMessage: string): Promise<void> {
    const customer = await this.store.getCustomer(customerId);
    if (!customer) return;
    customer.optedOut = true;
    customer.optedOutAt = this.now();
    await this.store.saveCustomer(customer);
    await this.store.appendAudit({
      actor: 'compliance_engine',
      action: 'customer.opted_out',
      entityTable: 'customers',
      entityId: customerId,
      after: { trigger: viaMessage },
    });
  }
}
