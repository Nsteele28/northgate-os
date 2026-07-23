// ── 1. AI Receptionist — never miss a contact ──────────────────────

import { looksLikeOptOut } from '../core/compliance.js';
import type { Channel, Customer, JourneyStage } from '../core/types.js';
import { AIEmployee } from './framework.js';
import { randomUUID } from 'node:crypto';

const EMERGENCY_PATTERNS = [
  /\bleak(ing)?\b/i, /\bwater (is |was )?(coming|pouring|dripping) (in|through)\b/i, /\btree (fell|on)\b/i,
  /\bcaved? in\b/i, /\bemergency\b/i, /\bcollaps/i, /\bhole in (the |my )?roof\b/i,
];

export type InboundClass = 'emergency' | 'new_inquiry' | 'existing_customer' | 'complex_or_upset';

export class Receptionist extends AIEmployee {
  readonly department = 'receptionist' as const;

  classify(message: string, isExistingCustomer: boolean): InboundClass {
    if (EMERGENCY_PATTERNS.some(p => p.test(message))) return 'emergency';
    if (/\b(angry|lawyer|sue|complaint|unacceptable|furious)\b/i.test(message)) return 'complex_or_upset';
    return isExistingCustomer ? 'existing_customer' : 'new_inquiry';
  }

  /**
   * Handle any inbound contact on any channel. Creates the customer
   * and opportunity if new, classifies, routes, and always leaves the
   * record in a stage with an owner.
   */
  async handleInbound(params: {
    channel: Channel;
    body: string;
    phone?: string;
    email?: string;
    name?: string;
  }): Promise<{ customerId: string; opportunityId?: string; classification: InboundClass | 'opt_out' }> {
    // Identify or create the customer
    let customer = await this.store.findCustomerByContact(params.phone, params.email);
    const isExisting = !!customer;
    if (!customer) {
      customer = {
        id: randomUUID(),
        firstName: params.name?.split(' ')[0],
        lastName: params.name?.split(' ').slice(1).join(' ') || undefined,
        phone: params.phone,
        email: params.email,
        consentSms: params.channel === 'sms', // inbound SMS establishes contactability for the thread
        consentEmail: params.channel === 'email',
        dnc: false,
        optedOut: false,
        archived: false,
      } satisfies Customer;
      await this.store.saveCustomer(customer);
    }

    // Opt-out is checked before anything else and is absolute.
    if (looksLikeOptOut(params.body)) {
      await this.emit('inbound.opt_out', { customerId: customer.id, payload: { body: params.body } });
      return { customerId: customer.id, classification: 'opt_out' };
    }

    const classification = this.classify(params.body, isExisting);

    // New inquiries get an opportunity record in `inbound_contact`.
    let opportunityId: string | undefined;
    if (classification === 'new_inquiry' || classification === 'emergency') {
      const opp = {
        id: randomUUID(),
        customerId: customer.id,
        stage: 'inbound_contact' as JourneyStage,
        stageEnteredAt: this.now(),
        owningDepartment: this.department,
        path: 'undecided' as const,
        source: `inbound_${params.channel}`,
        nextAction: 'Classify and route',
      };
      await this.store.saveOpportunity(opp);
      opportunityId = opp.id;
    }

    await this.decide(opportunityId, `Classified inbound as ${classification}`, { channel: params.channel, excerpt: params.body.slice(0, 120) }, 'Pattern + history classification');

    switch (classification) {
      case 'emergency':
        await this.emit('inbound.emergency', {
          opportunityId, customerId: customer.id,
          payload: { channel: params.channel, body: params.body },
        });
        // Acknowledge instantly while a human is paged (transactional: they contacted us)
        await this.speak(customer.id, opportunityId, params.channel,
          'emergency_acknowledgement',
          { promise: 'A live person is being notified right now', collect: 'address and photos if safe' },
          'transactional', 'customer-initiated emergency');
        break;
      case 'new_inquiry':
        await this.emit('inbound.new_inquiry', {
          opportunityId, customerId: customer.id,
          payload: { channel: params.channel, body: params.body },
        });
        await this.speak(customer.id, opportunityId, params.channel,
          'inquiry_acknowledgement_and_qualify',
          { question: params.body }, 'transactional', 'customer-initiated inquiry');
        break;
      case 'existing_customer':
        // Route to the owning department of their active opportunity via task
        await this.store.createTask({
          owner: 'customer_success',
          title: 'Existing-customer inbound: respond with full context',
          detail: { customerId: customer.id, channel: params.channel, body: params.body },
          createdBy: this.department,
        });
        await this.remember({
          customerId: customer.id, category: 'conversation_summary',
          content: `Inbound ${params.channel}: ${params.body.slice(0, 200)}`,
        });
        break;
      case 'complex_or_upset':
        await this.store.createTask({
          owner: 'human',
          title: 'Upset/complex inbound — human response needed',
          detail: { customerId: customer.id, channel: params.channel, body: params.body },
          createdBy: this.department,
        });
        await this.speak(customer.id, opportunityId, params.channel,
          'deescalation_handoff',
          { promise: 'a team member will reach out shortly' },
          'transactional', 'customer-initiated');
        break;
    }

    return { customerId: customer.id, opportunityId, classification };
  }

  /** Missed-call text-back: fires within 60s of an unanswered call. */
  async missedCallTextBack(phone: string): Promise<void> {
    const customer = await this.store.findCustomerByContact(phone);
    const customerId = customer?.id ?? (await this.handleInbound({ channel: 'call', body: '(missed call)', phone })).customerId;
    await this.speak(customerId, undefined, 'sms',
      'missed_call_text_back',
      { apology: 'sorry we missed you', offer: 'reply here or we can call back' },
      'transactional', 'customer called us');
  }
}
