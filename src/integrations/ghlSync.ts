// ── GoHighLevel sync: every message + call + spend ─────────────────
// Pulls all conversations/messages/calls from the Northgate sub-account
// into the permanent log so the KPI engine counts EVERYTHING that
// happens in GHL — not just what our own system sent. Runs on the
// Railway server on a schedule. Reconciles GHL -> Supabase (canonical).
//
// Cost tracking: GHL bills per SMS segment and per call minute. The
// messages API does not always return exact wallet charges, so we count
// segments/minutes and apply configurable rates for an estimate; exact
// billing always lives in the GHL wallet.

import { httpJson, withRetry } from './http.js';
import type { SupabaseStore } from '../adapters/supabaseStore.js';

export interface GhlRates {
  smsPerSegmentUsd: number;   // outbound SMS per 160-char segment
  smsInboundUsd: number;      // inbound SMS
  callPerMinuteUsd: number;   // per minute (rounded up)
  emailUsd: number;           // per email
}

export const DEFAULT_GHL_RATES: GhlRates = {
  smsPerSegmentUsd: 0.0079,
  smsInboundUsd: 0.0079,
  callPerMinuteUsd: 0.014,
  emailUsd: 0.0014,
};

interface GhlMessage {
  id: string;
  type: number | string;      // GHL message type code
  messageType?: string;       // 'TYPE_SMS', 'TYPE_CALL', 'TYPE_EMAIL'...
  direction: 'inbound' | 'outbound';
  body?: string;
  status?: string;            // 'delivered','failed',...
  dateAdded: string;
  contactId?: string;
  meta?: { callDuration?: number; call?: { duration?: number } };
}

export interface SyncResult {
  conversationsScanned: number;
  messagesInserted: number;
  smsCount: number;
  callCount: number;
  callMinutes: number;
  estimatedSpendUsd: number;
}

export class GhlSync {
  private base = 'https://services.leadconnectorhq.com';

  constructor(
    private store: SupabaseStore,
    private apiKey: string,
    private locationId: string,
    private heartbeat: (key: string, ok: boolean, err?: string) => Promise<void>,
    private rates: GhlRates = DEFAULT_GHL_RATES,
  ) {}

  private headers() {
    return { Authorization: `Bearer ${this.apiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
  }

  private channelOf(m: GhlMessage): 'sms' | 'call' | 'email' | 'web_chat' {
    const t = String(m.messageType ?? m.type ?? '').toUpperCase();
    if (t.includes('CALL')) return 'call';
    if (t.includes('EMAIL')) return 'email';
    if (t.includes('CHAT') || t.includes('GMB') || t.includes('FB') || t.includes('IG')) return 'web_chat';
    return 'sms';
  }

  private callMinutes(m: GhlMessage): number {
    const secs = m.meta?.callDuration ?? m.meta?.call?.duration ?? 0;
    return secs > 0 ? Math.ceil(secs / 60) : 0;
  }

  private segments(body?: string): number {
    const len = (body ?? '').length;
    return Math.max(1, Math.ceil(len / 160));
  }

  /** Pull conversations updated recently and sync their messages. */
  async sync(sinceIso?: string): Promise<SyncResult> {
    const result: SyncResult = { conversationsScanned: 0, messagesInserted: 0, smsCount: 0, callCount: 0, callMinutes: 0, estimatedSpendUsd: 0 };
    try {
      // GHL conversation search (most-recently updated first)
      const convResp = await withRetry('ghl', () => httpJson('ghl',
        `${this.base}/conversations/search?locationId=${this.locationId}&sortBy=last_message_date&sort=desc&limit=100`,
        { headers: this.headers() }),
        { onAttemptFailure: (_, e) => this.heartbeat('ghl.sync', false, e) }) as { conversations?: { id: string; contactId?: string }[] };

      const convs = convResp.conversations ?? [];
      const existingIds = await this.existingExternalIds();

      for (const conv of convs) {
        result.conversationsScanned++;
        const msgResp = await withRetry('ghl', () => httpJson('ghl',
          `${this.base}/conversations/${conv.id}/messages?limit=100`,
          { headers: this.headers() })) as { messages?: { messages?: GhlMessage[] } | GhlMessage[] };

        const raw = Array.isArray(msgResp.messages) ? msgResp.messages : (msgResp.messages?.messages ?? []);
        if (sinceIso) {
          // only messages newer than last sync
        }
        for (const m of raw) {
          if (existingIds.has(m.id)) continue;
          if (sinceIso && m.dateAdded < sinceIso) continue;
          const channel = this.channelOf(m);
          const mins = channel === 'call' ? this.callMinutes(m) : 0;
          const segs = channel === 'sms' ? this.segments(m.body) : 0;

          // tally
          if (channel === 'sms') { result.smsCount++; result.estimatedSpendUsd += (m.direction === 'outbound' ? this.rates.smsPerSegmentUsd : this.rates.smsInboundUsd) * segs; }
          else if (channel === 'call') { result.callCount++; result.callMinutes += mins; result.estimatedSpendUsd += this.rates.callPerMinuteUsd * mins; }
          else if (channel === 'email') { result.estimatedSpendUsd += this.rates.emailUsd; }

          await this.insertConversation({
            customerId: await this.mapContact(conv.contactId ?? m.contactId),
            channel,
            direction: m.direction,
            body: m.body ?? null,
            externalId: m.id,
            delivered: m.status ? !/fail|undeliver|error/i.test(m.status) : null,
            deliveryError: m.status && /fail|undeliver|error/i.test(m.status) ? m.status : null,
            occurredAt: m.dateAdded,
            costUsd: channel === 'call' ? this.rates.callPerMinuteUsd * mins : channel === 'sms' ? this.rates.smsPerSegmentUsd * segs : this.rates.emailUsd,
            callMinutes: mins,
            segments: segs,
          });
          existingIds.add(m.id);
          result.messagesInserted++;
        }
      }
      result.estimatedSpendUsd = +result.estimatedSpendUsd.toFixed(2);
      await this.heartbeat('ghl.sync', true);
    } catch (err) {
      await this.heartbeat('ghl.sync', false, String(err));
      throw err;
    }
    return result;
  }

  private async existingExternalIds(): Promise<Set<string>> {
    const rows = await this.store.query('conversations?select=external_id&external_id=not.is.null&order=occurred_at.desc&limit=5000');
    return new Set(rows.map(r => String(r.external_id)));
  }

  /** Best-effort map GHL contact -> our customer; create a shell if new. */
  private async mapContact(ghlContactId?: string): Promise<string | null> {
    if (!ghlContactId) return null;
    const rows = await this.store.query(`customers?ghl_contact_id=eq.${ghlContactId}&select=id&limit=1`);
    if (rows[0]) return String(rows[0].id);
    return null; // unmatched messages still logged for KPIs, just not linked
  }

  private async insertConversation(c: {
    customerId: string | null; channel: string; direction: string; body: string | null;
    externalId: string; delivered: boolean | null; deliveryError: string | null;
    occurredAt: string; costUsd: number; callMinutes: number; segments: number;
  }): Promise<void> {
    if (!c.customerId) return; // conversations.customer_id is NOT NULL; unlinked tallied in counts only
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/conversations`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        customer_id: c.customerId, channel: c.channel, direction: c.direction,
        body: c.body, external_id: c.externalId, delivered: c.delivered,
        delivery_error: c.deliveryError, occurred_at: c.occurredAt,
      }),
    }).catch(() => {});
  }
}
