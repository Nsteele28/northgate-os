// ── KPI engine + daily report ──────────────────────────────────────
// Reads the permanent logs (conversations, events, decisions, tasks,
// approvals, automation_health) and answers the question Natalie asked:
// what is and is not working, every single day — and what to change.
//
// Runs on the Railway server, which can reach Supabase directly.

import type { SupabaseStore } from '../adapters/supabaseStore.js';

export interface DailyKpis {
  date: string;
  // Outreach (Charles — our campaign only)
  messagesSent: number;
  messagesDelivered: number;
  messagesFailed: number;
  deliveryRate: number;
  // ALL GoHighLevel activity (incl. messages/calls not set up by our system)
  ghlTotalSms: number;
  ghlTotalCalls: number;
  ghlCallMinutes: number;
  ghlEstimatedSpendUsd: number;
  // Inbound
  inboundMessages: number;
  inboundCalls: number;
  missedCalls: number;
  missedCallTextbacks: number;
  // Engagement
  replies: number;
  replyRate: number;          // replies / messagesDelivered
  positiveReplies: number;
  negativeReplies: number;
  optOuts: number;
  // Conversion
  inspectionsBooked: number;
  bookRate: number;           // booked / peopleContacted
  noShows: number;
  // Experience / quality
  escalationsToHuman: number;
  badExperienceFlags: number; // negative sentiment on AI-handled convo
  medianFirstResponseMins: number | null;
  // Pipeline
  stageTransitions: number;
  stuckOpportunities: number;
  // Per-script performance — answers "should we change the message?"
  scriptPerformance: ScriptStat[];
  // Ops
  automationRed: number;
  automationYellow: number;
  pendingApprovals: number;
}

export interface ScriptStat {
  script: string;
  sent: number;
  replies: number;
  replyRate: number;
  booked: number;
  bookRate: number;
  optOuts: number;
}

export interface Recommendation {
  severity: 'info' | 'suggest' | 'urgent';
  area: string;
  finding: string;
  proposedChange: string;
  gated: boolean; // true → routed to approval queue before any GHL change
}

export interface DailyReport {
  kpis: DailyKpis;
  wins: string[];
  concerns: string[];
  recommendations: Recommendation[];
  narrative: string;
}

const POS = [/\byes\b/i, /\bsure\b/i, /\bsounds good\b/i, /\bok(ay)?\b/i, /\bplease do\b/i, /\bset it up\b/i, /\bthat works\b/i, /\bgo ahead\b/i, /\binterested\b/i];
const NEG = [/\bno\b/i, /\bstop\b/i, /\bnot interested\b/i, /\bremove\b/i, /\bwrong number\b/i, /\bwho is this\b/i, /\bscam\b/i, /\bleave me alone\b/i, /\bpissed\b/i, /\bangry\b/i, /\bunsubscribe\b/i];

function classify(body: string): 'positive' | 'negative' | 'neutral' {
  if (NEG.some(p => p.test(body))) return 'negative';
  if (POS.some(p => p.test(body))) return 'positive';
  return 'neutral';
}

export class KpiEngine {
  constructor(private store: SupabaseStore) {}

  // Direct REST helper (reuses the store's authenticated read surface)
  private async q(path: string): Promise<Record<string, unknown>[]> {
    return this.store.query(path);
  }

  async computeDay(dayIso: string, ghlTotals?: { sms: number; calls: number; callMins: number; spendUsd: number }): Promise<DailyKpis> {
    const start = `${dayIso}T00:00:00Z`;
    const end = `${dayIso}T23:59:59Z`;
    const conv = await this.q(`conversations?occurred_at=gte.${start}&occurred_at=lte.${end}&limit=100000`);
    const audit = await this.q(`audit_log?created_at=gte.${start}&created_at=lte.${end}&limit=100000`);
    const health = await this.q('automation_health');
    const pending = await this.q('approvals?status=eq.pending&select=id');

    const outbound = conv.filter(c => c.direction === 'outbound');
    const inbound = conv.filter(c => c.direction === 'inbound');
    const sms = (c: Record<string, unknown>) => c.channel === 'sms';
    const call = (c: Record<string, unknown>) => c.channel === 'call';
    // OUR campaign = outbound texts carrying a Charles script tag.
    const ourCampaign = (c: Record<string, unknown>) => sms(c) && c.script_tag != null;

    const sent = outbound.filter(ourCampaign).length;
    const delivered = outbound.filter(c => ourCampaign(c) && c.delivered === true).length;
    const failed = outbound.filter(c => ourCampaign(c) && c.delivered === false).length;

    // ALL GHL activity — prefer the live sync tally; fall back to the log.
    const ghlTotalSms = ghlTotals?.sms ?? conv.filter(sms).length;
    const ghlTotalCalls = ghlTotals?.calls ?? conv.filter(call).length;

    const replies = inbound.filter(sms);
    const pos = replies.filter(c => classify(String(c.body ?? '')) === 'positive').length;
    const neg = replies.filter(c => classify(String(c.body ?? '')) === 'negative').length;
    const optOuts = audit.filter(a => a.action === 'customer.opted_out').length;

    const booked = audit.filter(a => String(a.action).startsWith('journey.transition') && String(a.action).includes('inspection_scheduled')).length;
    const transitions = audit.filter(a => String(a.action).startsWith('journey.transition')).length;
    const escalations = (await this.q(`tasks?owner=eq.human&created_at=gte.${start}&created_at=lte.${end}&select=id`)).length;
    const badExp = replies.filter(c => classify(String(c.body ?? '')) === 'negative').length;

    const contacted = new Set(outbound.map(c => c.customer_id)).size;

    return {
      date: dayIso,
      messagesSent: sent,
      messagesDelivered: delivered,
      messagesFailed: failed,
      deliveryRate: sent ? +(delivered / sent).toFixed(3) : 0,
      ghlTotalSms,
      ghlTotalCalls,
      ghlCallMinutes: ghlTotals?.callMins ?? 0,
      ghlEstimatedSpendUsd: ghlTotals?.spendUsd ?? 0,
      inboundMessages: inbound.filter(sms).length,
      inboundCalls: inbound.filter(call).length,
      missedCalls: audit.filter(a => a.action === 'call.missed').length,
      missedCallTextbacks: outbound.filter(c => String((c.consent_basis ?? '')).includes('called us')).length,
      replies: replies.length,
      replyRate: delivered ? +(replies.length / delivered).toFixed(3) : 0,
      positiveReplies: pos,
      negativeReplies: neg,
      optOuts,
      inspectionsBooked: booked,
      bookRate: contacted ? +(booked / contacted).toFixed(3) : 0,
      noShows: audit.filter(a => String(a.action).includes('no_show')).length,
      escalationsToHuman: escalations,
      badExperienceFlags: badExp,
      medianFirstResponseMins: null,
      stageTransitions: transitions,
      stuckOpportunities: (await this.q('tasks?status=in.(open,in_progress)&title=like.STUCK*&select=id')).length,
      scriptPerformance: await this.perScript(outbound, replies, audit),
      automationRed: health.filter(h => h.status === 'red').length,
      automationYellow: health.filter(h => h.status === 'yellow').length,
      pendingApprovals: pending.length,
    };
  }

  private async perScript(outbound: Record<string, unknown>[], replies: Record<string, unknown>[], audit: Record<string, unknown>[]): Promise<ScriptStat[]> {
    // Group by the script tag stored on each outbound message's consent_basis/actor note.
    const byScript = new Map<string, { sent: number; custs: Set<string> }>();
    for (const m of outbound) {
      const tag = String((m.script_tag as string) ?? (m.actor as string) ?? 'unknown');
      if (!byScript.has(tag)) byScript.set(tag, { sent: 0, custs: new Set() });
      const g = byScript.get(tag)!;
      g.sent++; g.custs.add(String(m.customer_id));
    }
    const repliers = new Set(replies.map(r => String(r.customer_id)));
    const booked = new Set(audit.filter(a => String(a.action).includes('inspection_scheduled')).map(a => String(a.entity_id)));
    const out: ScriptStat[] = [];
    for (const [script, g] of byScript) {
      const repl = [...g.custs].filter(c => repliers.has(c)).length;
      const bk = [...g.custs].filter(c => booked.has(c)).length;
      out.push({
        script, sent: g.sent, replies: repl,
        replyRate: g.sent ? +(repl / g.sent).toFixed(3) : 0,
        booked: bk, bookRate: g.sent ? +(bk / g.sent).toFixed(3) : 0,
        optOuts: 0,
      });
    }
    return out.sort((a, b) => b.replyRate - a.replyRate);
  }

  /** Turn numbers into a story + recommendations. This is the "tell me
   *  what to change" brain. Recommendations that touch customer messaging
   *  or GHL config are marked gated → they go to the approval queue. */
  buildReport(k: DailyKpis, prior?: DailyKpis): DailyReport {
    const wins: string[] = [];
    const concerns: string[] = [];
    const recs: Recommendation[] = [];

    if (k.messagesSent === 0) {
      concerns.push('No outreach went out today (system is in propose mode or paused).');
    } else {
      if (k.deliveryRate < 0.9) {
        concerns.push(`Delivery rate ${(k.deliveryRate * 100).toFixed(0)}% — some texts are not landing.`);
        recs.push({ severity: 'urgent', area: 'Deliverability', finding: `${k.messagesFailed} messages failed to deliver.`, proposedChange: 'Check the GHL sending number / A2P registration; pause sends until delivery recovers.', gated: false });
      }
      if (k.replyRate < 0.08 && k.messagesDelivered > 40) {
        concerns.push(`Reply rate ${(k.replyRate * 100).toFixed(1)}% is low.`);
        const best = k.scriptPerformance[0];
        const worst = k.scriptPerformance[k.scriptPerformance.length - 1];
        if (best && worst && best.script !== worst.script) {
          recs.push({ severity: 'suggest', area: 'Messaging', finding: `"${best.script}" replies at ${(best.replyRate * 100).toFixed(0)}% vs "${worst.script}" at ${(worst.replyRate * 100).toFixed(0)}%.`, proposedChange: `Shift more volume to the "${best.script}" opener and rewrite the weaker one.`, gated: true });
        } else {
          recs.push({ severity: 'suggest', area: 'Messaging', finding: 'Low engagement across the board.', proposedChange: 'Test a shorter opener variant next batch.', gated: true });
        }
      } else if (k.replyRate >= 0.15) {
        wins.push(`Strong reply rate: ${(k.replyRate * 100).toFixed(0)}%.`);
      }
      if (k.optOuts / Math.max(1, k.messagesDelivered) > 0.05) {
        concerns.push(`Opt-out rate elevated (${k.optOuts} today).`);
        recs.push({ severity: 'urgent', area: 'Messaging', finding: 'Opt-outs above 5% signals the message or targeting feels like spam.', proposedChange: 'Soften the opener and tighten targeting to only genuinely storm/aged-roof matches.', gated: true });
      }
      if (k.inspectionsBooked > 0) wins.push(`${k.inspectionsBooked} inspection(s) booked.`);
    }

    if (k.badExperienceFlags > 0) {
      concerns.push(`${k.badExperienceFlags} conversation(s) flagged as a bad experience.`);
      recs.push({ severity: 'urgent', area: 'Customer experience', finding: 'Homeowners reacted negatively in AI-handled threads.', proposedChange: 'Review the flagged threads (linked in the queue); adjust tone or hand those situations to a human sooner.', gated: false });
    }
    if (k.automationRed > 0) {
      concerns.push(`${k.automationRed} automation(s) are down (red).`);
      recs.push({ severity: 'urgent', area: 'System health', finding: 'A connected system is failing.', proposedChange: 'Check the integration keys; sends are paused for the affected channel.', gated: false });
    }
    if (k.stuckOpportunities > 0) concerns.push(`${k.stuckOpportunities} opportunit(ies) stuck past their time limit.`);
    if (k.escalationsToHuman > 0) concerns.push(`${k.escalationsToHuman} item(s) waiting on a human.`);

    const narrative = this.narrate(k, wins, concerns, prior);
    return { kpis: k, wins, concerns, recommendations: recs, narrative };
  }

  private narrate(k: DailyKpis, wins: string[], concerns: string[], prior?: DailyKpis): string {
    const parts: string[] = [];
    parts.push(`On ${k.date}, Charles sent ${k.messagesSent} texts (${(k.deliveryRate * 100).toFixed(0)}% delivered) and heard back from ${k.replies} homeowners (${(k.replyRate * 100).toFixed(1)}% reply rate). ${k.inspectionsBooked} inspection(s) booked, ${k.optOuts} opt-out(s).`);
    parts.push(`Inbound: ${k.inboundMessages} texts and ${k.inboundCalls} calls came in; ${k.escalationsToHuman} needed a human.`);
    if (prior) {
      const dRep = k.replyRate - prior.replyRate;
      parts.push(`Reply rate ${dRep >= 0 ? 'up' : 'down'} ${Math.abs(dRep * 100).toFixed(1)} pts vs yesterday.`);
    }
    if (wins.length) parts.push('Working: ' + wins.join(' '));
    if (concerns.length) parts.push('Watch: ' + concerns.join(' '));
    return parts.join(' ');
  }
}
