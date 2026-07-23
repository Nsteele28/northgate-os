// ── Department framework ───────────────────────────────────────────
// Shared services every AI employee uses: compliant outbound comms,
// customer-memory context, decision logging, and event emission.
// The conversational intelligence is pluggable (Brain interface) so
// safety rails live in code, not in a prompt.

import { ComplianceEngine } from '../core/compliance.js';
import type { Store } from '../core/store.js';
import type { Channel, Department, MemoryEntry, OutboundMessage } from '../core/types.js';
import { emit } from '../director/router.js';

/** Pluggable LLM layer. Production wires an Anthropic-API implementation;
 *  tests use scripted brains. Brains draft language — they never gate. */
export interface Brain {
  draft(params: {
    department: Department;
    purpose: string;
    customerContext: MemoryEntry[];
    conversationHint?: string;
    facts: Record<string, unknown>;
  }): Promise<string>;
  classify?(params: { text: string; labels: string[] }): Promise<string>;
}

/** Deterministic brain for tests/dev: templates, no model. */
export class TemplateBrain implements Brain {
  async draft(p: { purpose: string; facts: Record<string, unknown> }): Promise<string> {
    return `[${p.purpose}] ${JSON.stringify(p.facts)}`;
  }
  async classify(p: { text: string; labels: string[] }): Promise<string> {
    return p.labels[0]!;
  }
}

export interface SendResult { sent: boolean; blockedReason?: string }

export class CommsService {
  constructor(
    private store: Store,
    private compliance: ComplianceEngine,
    private transport: (msg: OutboundMessage) => Promise<void>, // integration adapter
  ) {}

  /**
   * Every outbound message in the entire system flows through here:
   * compliance gate → transport → conversation log. A blocked send is
   * logged and reported, never silently dropped.
   */
  async send(msg: OutboundMessage, kind: 'sales' | 'transactional'): Promise<SendResult> {
    try {
      await this.compliance.assertSendable(msg, kind);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.store.appendAudit({
        actor: msg.actor,
        action: 'comms.blocked',
        entityTable: 'customers',
        entityId: msg.customerId,
        after: { channel: msg.channel, reason },
      });
      return { sent: false, blockedReason: reason };
    }
    try {
      await this.transport(msg);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await emit(this.store, 'comms.delivery_failed', msg.actor, {
        customerId: msg.customerId,
        opportunityId: msg.opportunityId,
        payload: { channel: msg.channel, reason },
      });
      return { sent: false, blockedReason: `delivery failed: ${reason}` };
    }
    await this.store.appendAudit({
      actor: msg.actor,
      action: 'comms.sent',
      entityTable: 'customers',
      entityId: msg.customerId,
      after: { channel: msg.channel, consentBasis: msg.consentBasis },
    });
    return { sent: true };
  }
}

/** Base class: every AI employee gets the same shared services. */
export abstract class AIEmployee {
  abstract readonly department: Department;

  constructor(
    protected store: Store,
    protected comms: CommsService,
    protected brain: Brain,
    protected now: () => Date = () => new Date(),
  ) {}

  /** Full customer context injected before any interaction. */
  protected async context(customerId: string): Promise<MemoryEntry[]> {
    return this.store.getMemory(customerId);
  }

  protected async remember(entry: Omit<MemoryEntry, 'createdAt' | 'source'>): Promise<void> {
    await this.store.appendMemory({ ...entry, source: this.department });
  }

  protected async decide(opportunityId: string | undefined, decision: string, inputs: Record<string, unknown>, reasoning: string): Promise<void> {
    await this.store.recordDecision({ actor: this.department, opportunityId, decision, inputs, reasoning });
  }

  protected async emit(eventType: string, opts: { opportunityId?: string; customerId?: string; payload?: Record<string, unknown> } = {}) {
    return emit(this.store, eventType, this.department, opts);
  }

  protected async speak(
    customerId: string,
    opportunityId: string | undefined,
    channel: Channel,
    purpose: string,
    facts: Record<string, unknown>,
    kind: 'sales' | 'transactional',
    consentBasis: string,
  ): Promise<SendResult> {
    const customerContext = await this.context(customerId);
    const body = await this.brain.draft({
      department: this.department, purpose, customerContext, facts,
    });
    return this.comms.send(
      { customerId, opportunityId, channel, body, actor: this.department, consentBasis },
      kind,
    );
  }
}
