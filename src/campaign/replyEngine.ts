// ── Charles reply engine ───────────────────────────────────────────
// Reads inbound replies to the recap campaign and answers them in
// Charles's voice. Behavior (owner rules):
//   • still needs it   -> offer a free inspection, ask for a day
//   • already handled  -> thank warmly, leave door open for referral
//   • price question   -> free-inspection framing, never a firm quote
//   • agrees to a time  -> DON'T auto-book; queue for human confirm + alert
//   • opt out          -> honor instantly and permanently, no reply
//   • unclear / upset  -> escalate to a human, don't guess
// Guards: wait ~2 min after their last text (so 5 texts get ONE reply),
// never reply twice, name-first, no dashes, varied wording.
//
// Uses GoHighLevel as the source of truth for conversation state, so it
// is stateless and safe across restarts.

import type { SupabaseStore } from '../adapters/supabaseStore.js';

export type Intent = 'opt_out' | 'already_done' | 'still_need' | 'price' | 'book_time' | 'wrong_number' | 'unclear';

export interface ReplyConfig {
  enabled: boolean;
  debounceMinutes: number;
  lookbackHours: number;   // only look at conversations touched this recently
  maxPerCycle: number;
}

export const DEFAULT_REPLY: ReplyConfig = {
  enabled: true,
  debounceMinutes: 2,
  lookbackHours: 12,
  maxPerCycle: 40,
};

const P = {
  optOut: [/\bstop\b/i, /\bunsubscribe\b/i, /\bremove me\b/i, /\bopt.?out\b/i, /\bleave me alone\b/i, /\btake me off\b/i, /\bquit\b/i],
  done: [/\balready\b/i, /\bdid it\b/i, /\bi did\b/i, /\bgot it (done|fixed|taken)/i, /\btaken care of\b/i, /\bwe moved\b/i, /\bmoved\b/i, /\bsold\b/i, /\bno longer\b/i, /\bhandled\b/i, /\bdone\b/i, /\bfixed it\b/i, /\bnot needed\b/i, /\ball set\b/i, /\bgood now\b/i],
  wrong: [/\bwrong number\b/i, /\bwho is this\b/i, /\bwho are you\b/i, /\bdon'?t know\b/i, /\bnever (contacted|reached)/i, /\bnot me\b/i],
  price: [/\bhow much\b/i, /\bcost\b/i, /\bprice\b/i, /\bquote\b/i, /\bestimate\b/i, /\$\s?\d/],
  bookTime: [/\bmonday\b/i, /\btuesday\b/i, /\bwednesday\b/i, /\bthursday\b/i, /\bfriday\b/i, /\bsaturday\b/i, /\bsunday\b/i, /\btomorrow\b/i, /\bthis week\b/i, /\bnext week\b/i, /\bmorning\b/i, /\bafternoon\b/i, /\b\d{1,2}\s?(am|pm)\b/i, /\bset it up\b/i, /\bbook it\b/i, /\bsounds good\b/i, /\blet'?s do it\b/i, /\bschedule\b/i, /\bcome (out|by)\b/i],
  stillNeed: [/\bstill\b/i, /\byes\b/i, /\byeah\b/i, /\byep\b/i, /\bnot yet\b/i, /\bhaven'?t\b/i, /\bneed\b/i, /\bcould use\b/i, /\binterested\b/i, /\bplease\b/i, /\bwhen can\b/i, /\bsure\b/i],
};

export function classify(text: string): Intent {
  const t = text.toLowerCase();
  if (P.optOut.some(r => r.test(t))) return 'opt_out';
  if (P.wrong.some(r => r.test(t))) return 'wrong_number';
  // "yes I did" / "already taken care of" => done beats still_need
  if (P.done.some(r => r.test(t))) return 'already_done';
  if (P.bookTime.some(r => r.test(t))) return 'book_time';
  if (P.price.some(r => r.test(t))) return 'price';
  if (P.stillNeed.some(r => r.test(t))) return 'still_need';
  return 'unclear';
}

// Varied replies; picked by a rotating index so no two are identical.
const REPLIES: Record<Exclude<Intent, 'opt_out' | 'unclear'>, ((n: string) => string)[]> = {
  still_need: [
    n => `Good deal ${n}, glad we caught you then. I can have a tech swing by this week to take a look and get you a straight answer. What works better for you, a weekday or the weekend?`,
    n => `Perfect ${n}. Easiest thing is to get one of our guys out there for a quick free look. You more of a morning or afternoon person for something like that?`,
    n => `Awesome ${n}, let's get it handled. I've got a tech in your area this week. What day works best and I'll get you on the schedule?`,
  ],
  already_done: [
    n => `Awesome ${n}, glad you got it taken care of. If anything ever comes up down the road, or you know someone who needs a roof, we take great care of referrals. Take care!`,
    n => `Good to hear ${n}, glad it's handled. Keep us in mind if you ever need anything or have a neighbor who does. Appreciate you!`,
    n => `Perfect ${n}, that's what I like to hear. If it ever acts up or a friend needs work done, just text me here. Have a good one!`,
  ],
  price: [
    n => `Totally fair question ${n}. It really depends on the roof, so the free inspection is how we get you an exact number. And if there's any storm damage, insurance may cover a good chunk. Want me to get a tech out this week to take a look?`,
    n => `Great question ${n}. I can't give you a real number without eyes on it, which is why the inspection is free. Should I set one up for you this week?`,
  ],
  wrong_number: [
    n => `So sorry about that ${n}, looks like I've got the wrong info. I'll take you right off my list. Have a good one!`,
    n => `My apologies, sounds like I've got the wrong number. I'll make sure you don't hear from me again. Take care!`,
  ],
  book_time: [
    n => `Perfect ${n}, let me get that locked in and someone will text you to confirm the exact time shortly. Talk soon!`,
    n => `You got it ${n}, I'll get that on the schedule and we'll confirm the time with you right away. Appreciate you!`,
  ],
};

export interface ReplyResult { answered: number; escalated: number; optOuts: number; booked: number; }

interface GhlMsg { id: string; direction: 'inbound' | 'outbound'; body?: string; dateAdded: string; messageType?: string; type?: string | number; }

export class ReplyEngine {
  private base = 'https://services.leadconnectorhq.com';
  private idx = 0;

  constructor(
    private store: SupabaseStore,
    private ghlKey: string,
    private ghlLoc: string,
    private alertOwner: (headline: string, detail: string) => Promise<void>,
    private cfg: ReplyConfig = DEFAULT_REPLY,
    private now: () => number = () => Date.now(),
  ) {}

  private gh() { return { Authorization: `Bearer ${this.ghlKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' }; }
  private isSms(m: GhlMsg) { return String(m.messageType ?? m.type ?? '').toUpperCase().includes('SMS') || !String(m.messageType ?? m.type ?? '').toUpperCase().includes('CALL'); }

  async cycle(): Promise<ReplyResult> {
    const res: ReplyResult = { answered: 0, escalated: 0, optOuts: 0, booked: 0 };
    if (!this.cfg.enabled) return res;

    const cutoff = this.now() - this.cfg.lookbackHours * 3_600_000;
    const search = await fetch(`${this.base}/conversations/search?locationId=${this.ghlLoc}&limit=60&sortBy=last_message_date&sort=desc`, { headers: this.gh() })
      .then(r => r.json()).catch(() => ({ conversations: [] })) as { conversations?: { id: string; contactId?: string; contactName?: string; fullName?: string; lastMessageDate?: string; lastMessageType?: string }[] };

    let processed = 0;
    for (const conv of search.conversations ?? []) {
      if (processed >= this.cfg.maxPerCycle) break;
      const lastAt = conv.lastMessageDate ? new Date(conv.lastMessageDate).getTime() : 0;
      if (lastAt < cutoff) break; // sorted desc — older than lookback, stop

      try {
        const handled = await this.handleConversation(conv, res);
        if (handled) processed++;
      } catch { /* keep going */ }
    }
    return res;
  }

  private async handleConversation(conv: { id: string; contactId?: string; contactName?: string; fullName?: string }, res: ReplyResult): Promise<boolean> {
    const m = await fetch(`${this.base}/conversations/${conv.id}/messages?limit=25`, { headers: this.gh() })
      .then(r => r.json()).catch(() => null) as { messages?: { messages?: GhlMsg[] } | GhlMsg[] } | null;
    if (!m) return false;
    const raw = (Array.isArray(m.messages) ? m.messages : m.messages?.messages ?? []).filter(x => this.isSms(x));
    const msgs = raw.slice().sort((a, b) => new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime());
    if (!msgs.length) return false;

    // Scope to our recap campaign: must contain a Charles recap outbound.
    const recapIdx = msgs.findIndex(x => x.direction === 'outbound' && /Northgate/i.test(x.body ?? '') && /(wrapped up|Circling back|fell off|finished up|getting it taken care of)/i.test(x.body ?? ''));
    if (recapIdx === -1) return false;

    const after = msgs.slice(recapIdx + 1);
    const inbound = after.filter(x => x.direction === 'inbound');
    if (!inbound.length) return false;

    const lastInbound = inbound[inbound.length - 1]!;
    const lastInboundAt = new Date(lastInbound.dateAdded).getTime();
    // Debounce: give them ~2 min to finish typing.
    if (this.now() - lastInboundAt < this.cfg.debounceMinutes * 60_000) return false;
    // Already replied after their last message?
    const outboundAfterLastInbound = after.some(x => x.direction === 'outbound' && new Date(x.dateAdded).getTime() > lastInboundAt);
    if (outboundAfterLastInbound) return false;

    const first = (conv.contactName || conv.fullName || 'there').split(' ')[0] || 'there';
    const combined = inbound.map(x => x.body ?? '').join(' ');
    const intent = classify(combined);
    const contactId = conv.contactId!;

    // Opt out — honor, do not reply.
    if (intent === 'opt_out') {
      await this.markCustomerByContact(contactId, { opted_out: true, opted_out_at: new Date().toISOString() });
      await this.logInbound(contactId, combined, 'opt_out');
      res.optOuts++;
      return true;
    }

    // Unclear — escalate to a human, do not guess.
    if (intent === 'unclear') {
      await this.escalate(conv, combined, 'Reply needs a human (unclear intent)');
      res.escalated++;
      return true;
    }

    const reply = this.pick(intent, first);
    const sent = await this.sendSms(contactId, reply);
    if (!sent) return false;
    await this.logReply(contactId, combined, reply, intent);
    this.idx++;

    if (intent === 'wrong_number') {
      await this.markCustomerByContact(contactId, { opted_out: true, opted_out_at: new Date().toISOString() });
    }
    if (intent === 'book_time') {
      // Agreed to a time — a human confirms the actual appointment.
      await this.queueBookingApproval(conv, combined);
      await this.alertOwner(`Inspection to confirm: ${first}`, `${first} wants to schedule an inspection ("${combined.slice(0, 80)}"). Charles held the spot; confirm the exact time in your queue.`);
      res.booked++;
    }
    if (intent === 'still_need' || intent === 'price') {
      await this.alertOwner(`Hot reply: ${first} still needs their roof`, `${first} replied "${combined.slice(0, 80)}". Charles offered a free inspection and asked for a day. Watch for their time.`);
    }
    res.answered++;
    return true;
  }

  private pick(intent: Exclude<Intent, 'opt_out' | 'unclear'>, name: string): string {
    const arr = REPLIES[intent];
    return arr[this.idx % arr.length]!(name);
  }

  private async sendSms(contactId: string, message: string): Promise<boolean> {
    const r = await fetch(`${this.base}/conversations/messages`, { method: 'POST', headers: this.gh(), body: JSON.stringify({ type: 'SMS', contactId, message }) }).catch(() => null);
    return !!r && r.ok;
  }

  private async sb(path: string, init: RequestInit) {
    return fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal', ...(init.headers ?? {}),
      },
    }).catch(() => {});
  }

  private async markCustomerByContact(ghlContactId: string, patch: Record<string, unknown>) {
    await this.sb(`customers?ghl_contact_id=eq.${ghlContactId}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }

  private async logReply(contactId: string, inbound: string, reply: string, intent: string) {
    await this.sb('conversations', { method: 'POST', body: JSON.stringify({ channel: 'sms', direction: 'inbound', body: inbound, external_id: `in_${contactId}_${Date.now()}`, sentiment: intent, script_tag: 'recap_reply_in' }) });
    await this.sb('conversations', { method: 'POST', body: JSON.stringify({ channel: 'sms', direction: 'outbound', actor: 'inside_sales', body: reply, external_id: `out_${contactId}_${Date.now()}`, script_tag: 'recap_reply_out', delivered: true, consent_basis: 'customer replied to us' }) });
  }
  private async logInbound(contactId: string, inbound: string, intent: string) {
    await this.sb('conversations', { method: 'POST', body: JSON.stringify({ channel: 'sms', direction: 'inbound', body: inbound, external_id: `in_${contactId}_${Date.now()}`, sentiment: intent, script_tag: 'recap_reply_in' }) });
  }

  private async escalate(conv: { contactName?: string; fullName?: string }, text: string, why: string) {
    const who = conv.contactName || conv.fullName || 'a homeowner';
    await this.sb('tasks', { method: 'POST', body: JSON.stringify({ owner: 'human', title: `Reply needs you: ${who}`, detail: { text, why }, created_by: 'inside_sales' }) });
    await this.alertOwner(`Reply needs a human: ${who}`, `They said: "${text.slice(0, 90)}". Charles wasn't sure how to answer, so it's in your queue.`);
  }

  private async queueBookingApproval(conv: { contactName?: string; fullName?: string; contactId?: string }, text: string) {
    await this.sb('approvals', { method: 'POST', body: JSON.stringify({
      action: 'send_contract', // reused as a generic "confirm appointment" gate
      requested_by: 'inside_sales',
      summary: `Confirm inspection for ${conv.contactName || conv.fullName || 'homeowner'}`,
      work_product: { contactId: conv.contactId, theySaid: text },
      reasoning: 'Homeowner agreed to schedule an inspection off the recap reply. A human should confirm the exact time and tech.',
      urgency: 'high',
    }) });
  }
}
