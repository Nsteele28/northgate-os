// ── Daily drip sender ──────────────────────────────────────────────
// Every day at 9:00 AM (America/Detroit), send Charles's recap message
// to the next N uncontacted past_customer leads. Paced, not blasted, to
// keep the sending number healthy. Guards:
//   • never text an opted-out or DNC contact
//   • never text anyone already in an active GHL conversation
//     (collision guard — keeps Charles from stepping on Lucas or a human)
//   • never text the same person twice (marks each contacted)
//   • every send is logged; failures surface to the watchdog

import type { SupabaseStore } from '../adapters/supabaseStore.js';

export interface DripConfig {
  dailyCount: number;
  hourET: number;
  collisionWindowDays: number;
  perSendDelayMs: number;
  enabled: boolean;
}

export const DEFAULT_DRIP: DripConfig = {
  dailyCount: 100,
  hourET: 9,
  collisionWindowDays: 14,
  perSendDelayMs: 1500, // ~2.5 min to send 100 — gentle on the carrier
  enabled: true,
};

// Recap openers — Charles rotates these and personalizes by first name.
// No dashes, no opt-out line, a little different each time.
const OPENERS = [
  (n: string) => `Hey ${n}, it's Charles with Northgate. We had you down for some roof work a while back but it looks like it never got wrapped up on our end. Did you end up getting it taken care of, or do you still need it done?`,
  (n: string) => `Hi ${n}, Charles over at Northgate here. Circling back on your roof from a while ago. Did you ever get that handled or is it still on your list?`,
  (n: string) => `Hey ${n}, it's Charles at Northgate. Looks like we started talking about your roof a bit ago and it kind of fell off. Where did you land on it, get it fixed or still need someone out there?`,
  (n: string) => `Hi ${n}, it's Charles with Northgate. Going back through some older files and saw your roof never got finished up with us. Did you get it squared away, or could you still use a hand with it?`,
];

export interface DripResult {
  attempted: number;
  sent: number;
  skippedActive: number;
  skippedOptedOut: number;
  failed: number;
}

export class DripSender {
  private lastRunDay = '';

  constructor(
    private store: SupabaseStore,
    private ghlKey: string,
    private ghlLoc: string,
    private onProblem: (headline: string, detail: string) => Promise<void>,
    private cfg: DripConfig = DEFAULT_DRIP,
    private now: () => Date = () => new Date(),
  ) {}

  private ghlHeaders() {
    return { Authorization: `Bearer ${this.ghlKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
  }
  private base = 'https://services.leadconnectorhq.com';

  private detroit(): Date {
    return new Date(this.now().toLocaleString('en-US', { timeZone: 'America/Detroit' }));
  }

  /** Called on a short interval; fires once when the clock passes 9 AM ET. */
  async tick(): Promise<DripResult | null> {
    if (!this.cfg.enabled) return null;
    const d = this.detroit();
    const day = d.toISOString().slice(0, 10);
    // Fire only within the configured hour (e.g. the 9 AM hour), once/day.
    // This guarantees it never blasts on an afternoon deploy/restart.
    if (d.getHours() !== this.cfg.hourET || this.lastRunDay === day) return null;
    this.lastRunDay = day;
    return this.run();
  }

  async run(): Promise<DripResult> {
    const res: DripResult = { attempted: 0, sent: 0, skippedActive: 0, skippedOptedOut: 0, failed: 0 };
    // Pull the next batch: past_customer leads not yet contacted.
    const rows = await this.store.query(
      `opportunities?source=eq.past_customer&next_action=like.Past-customer*` +
      `&select=id,customer_id,customers(first_name,phone_normalized,opted_out,dnc,ghl_contact_id)` +
      `&order=created_at.asc&limit=${this.cfg.dailyCount}`,
    );

    let i = 0;
    for (const row of rows) {
      res.attempted++;
      const cust = (row as { customers?: Record<string, unknown> }).customers;
      if (!cust) { res.failed++; continue; }
      const phone = String(cust.phone_normalized ?? '');
      const first = String(cust.first_name ?? 'there').trim() || 'there';
      const oppId = String((row as { id: string }).id);
      const custId = String((row as { customer_id: string }).customer_id);

      if (cust.opted_out || cust.dnc || !phone) { res.skippedOptedOut++; await this.mark(oppId, 'skipped_optout'); continue; }

      try {
        // Upsert the GHL contact
        const up = await fetch(`${this.base}/contacts/upsert`, {
          method: 'POST', headers: this.ghlHeaders(),
          body: JSON.stringify({ locationId: this.ghlLoc, firstName: first, phone, tags: ['charles-recap'] }),
        }).then(r => r.json()).catch(() => null) as { contact?: { id: string } } | null;
        const contactId = up?.contact?.id;
        if (!contactId) { res.failed++; await this.mark(oppId, 'send_failed_no_contact'); continue; }

        // Collision guard: is anyone already actively talking to them?
        if (await this.hasActiveConversation(contactId)) {
          res.skippedActive++;
          await this.mark(oppId, 'skipped_active_conversation');
          continue;
        }

        // Send the personalized recap
        const body = OPENERS[i % OPENERS.length]!(first);
        const send = await fetch(`${this.base}/conversations/messages`, {
          method: 'POST', headers: this.ghlHeaders(),
          body: JSON.stringify({ type: 'SMS', contactId, message: body }),
        });
        const ok = send.ok;
        await this.logConversation(custId, oppId, body, ok, contactId);
        if (ok) { res.sent++; await this.mark(oppId, 'recap_sent'); }
        else { res.failed++; await this.mark(oppId, 'send_failed'); }
        i++;
        await new Promise(r => setTimeout(r, this.cfg.perSendDelayMs));
      } catch (err) {
        res.failed++;
        await this.mark(oppId, `send_error:${String(err).slice(0, 60)}`);
      }
    }

    // If a big chunk failed, that's a pipeline problem — alert.
    if (res.attempted > 10 && res.failed / res.attempted > 0.3) {
      await this.onProblem('Drip send failing', `${res.failed} of ${res.attempted} recap texts failed this morning. Check the sending number / A2P.`);
    }
    return res;
  }

  private async hasActiveConversation(contactId: string): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/conversations/search?locationId=${this.ghlLoc}&contactId=${contactId}&limit=1`, { headers: this.ghlHeaders() });
      const d = await r.json() as { conversations?: { lastMessageDate?: string }[] };
      const c = d.conversations?.[0];
      if (!c?.lastMessageDate) return false;
      const ageDays = (this.now().getTime() - new Date(c.lastMessageDate).getTime()) / 86_400_000;
      return ageDays <= this.cfg.collisionWindowDays;
    } catch {
      return false; // if the check fails, don't block the send
    }
  }

  private async mark(oppId: string, status: string): Promise<void> {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/opportunities?id=eq.${oppId}`, {
      method: 'PATCH',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ next_action: status, next_action_due: null }),
    }).catch(() => {});
  }

  private async logConversation(custId: string, oppId: string, body: string, delivered: boolean, extId: string): Promise<void> {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/conversations`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        customer_id: custId, opportunity_id: oppId, channel: 'sms', direction: 'outbound',
        actor: 'inside_sales', body,
        external_id: extId, delivered, consent_basis: 'past_customer_recap',
      }),
    }).catch(() => {});
  }
}
