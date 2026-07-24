// ── Northgate OS — production entrypoint ───────────────────────────
// Runs on the always-on server (Railway). The heartbeat of the company:
//   • drains the event bus through the Operations Director (every 30s)
//   • runs the Executive Ops sweep (every 15 min)
//   • serves a health endpoint so the platform can watch the watcher
//
// PROPOSE MODE: while NORTHGATE_MODE=propose (the default), no message
// is transported to a customer — outbound sends are written to the
// approval queue as drafts instead. Flip to 'live' per department only
// after Natalie signs off.

import { createServer } from 'node:http';
import { SupabaseStore } from './adapters/supabaseStore.js';
import { ApprovalService } from './core/approvals.js';
import { ComplianceEngine } from './core/compliance.js';
import { OperationsDirector } from './director/router.js';
import { CommsService } from './departments/framework.js';
import { ExecutiveOps } from './health/executiveOps.js';
import { KpiEngine } from './reporting/kpis.js';
import type { OutboundMessage } from './core/types.js';

const env = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback;
  if (v == null) throw new Error(`Missing required env var ${k}`);
  return v;
};

const MODE = env('NORTHGATE_MODE', 'propose'); // 'propose' | 'live'

const store = new SupabaseStore({
  url: env('SUPABASE_URL'),
  serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
});

const compliance = new ComplianceEngine(store);
const approvals = new ApprovalService(store);
const director = new OperationsDirector(store);

// In propose mode the "transport" never touches a customer: every
// would-be send becomes a task for a human to review in the queue.
const transport = async (msg: OutboundMessage): Promise<void> => {
  if (MODE !== 'live') {
    await store.createTask({
      owner: 'human',
      title: `[PROPOSE MODE] Draft ${msg.channel} for review — would have sent to customer`,
      detail: { draft: msg.body, channel: msg.channel, customerId: msg.customerId, actor: msg.actor },
      createdBy: msg.actor,
    });
    return;
  }
  // live mode: GHL adapter wiring goes here per-channel (Phase 2 flip)
  throw new Error('live transport not yet enabled — flip departments one at a time');
};

const comms = new CommsService(store, compliance, transport);
void comms; // departments attach here as campaign phases activate

const notifyManagement = async (e: { what: string; recommendedAction: string }): Promise<void> => {
  // Paging wiring (SMS to owners) activates with live mode; until then
  // escalations surface in the dashboard + task queue, never silently.
  await store.createTask({
    owner: 'human',
    title: `🚨 ESCALATION: ${e.what}`,
    detail: { recommendedAction: e.recommendedAction },
    createdBy: 'executive_operations',
  });
};

const execOps = new ExecutiveOps(store, director, approvals, notifyManagement);

// ── The loops ──────────────────────────────────────────────────────

let lastDrain = 'never', lastSweep = 'never', drains = 0, sweeps = 0;

async function drainLoop(): Promise<void> {
  try {
    const n = await director.drain(200);
    drains++;
    lastDrain = new Date().toISOString();
    await execOps.heartbeat('director.drain', 'operations_director', true);
    if (n > 0) console.log(`[drain] processed ${n} events`);
  } catch (err) {
    console.error('[drain] failed:', err);
    await execOps.heartbeat('director.drain', 'operations_director', false, String(err)).catch(() => {});
  }
}

async function sweepLoop(): Promise<void> {
  try {
    const result = await execOps.sweep();
    sweeps++;
    lastSweep = new Date().toISOString();
    console.log(`[sweep] stuck=${result.stuckCount} escalations=${result.escalations.length}`);
  } catch (err) {
    console.error('[sweep] failed:', err);
  }
}

// ── Daily KPI report (end of day, America/Detroit) ─────────────────

const kpi = new KpiEngine(store);
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'ngc.nsteele@gmail.com';
const REPORT_HOUR_ET = Number(process.env.REPORT_HOUR_ET ?? 20); // 8pm ET default
let lastReportDay = '';

function nowInDetroit(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Detroit' }));
}

async function maybeRunDailyReport(): Promise<void> {
  const now = nowInDetroit();
  const day = now.toISOString().slice(0, 10);
  if (now.getHours() < REPORT_HOUR_ET || lastReportDay === day) return;
  lastReportDay = day;
  try {
    const kpis = await kpi.computeDay(day);
    let prior;
    try {
      const yday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
      prior = await kpi.computeDay(yday);
    } catch { /* first day */ }
    const report = kpi.buildReport(kpis, prior);

    // 1. Persist the full report (the dashboard + history read this)
    await store.query(`daily_reports`).catch(() => []); // ensure table reachable
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/daily_reports`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ report_date: day, kpis: report.kpis, wins: report.wins, concerns: report.concerns, recommendations: report.recommendations, narrative: report.narrative }),
    }).catch(e => console.error('[report] persist failed', e));

    // 2. Every gated recommendation becomes an approval item (nothing
    //    changes in GHL until Natalie says yes).
    for (const rec of report.recommendations.filter(r => r.gated)) {
      await store.createApproval({
        action: 'change_pricing', // reused as a generic "config change" gate
        requestedBy: 'executive_operations',
        summary: `[${rec.area}] ${rec.proposedChange}`,
        workProduct: { finding: rec.finding, proposedChange: rec.proposedChange, severity: rec.severity },
        reasoning: rec.finding,
        consequences: 'Approved: change applied to messaging/GHL config. Denied: no change.',
        urgency: rec.severity === 'urgent' ? 'high' : 'normal',
      }).catch(e => console.error('[report] approval failed', e));
    }

    // 3. Email the story to Natalie (internal owner notification — not
    //    customer outreach, so it bypasses propose mode).
    await emailOwner(day, report).catch(e => console.error('[report] email failed', e));
    console.log(`[report] daily report for ${day} generated: ${report.recommendations.length} recommendations`);
  } catch (err) {
    console.error('[report] failed:', err);
  }
}

async function emailOwner(day: string, report: import('./reporting/kpis.js').DailyReport): Promise<void> {
  const key = process.env.GHL_API_KEY, loc = process.env.GHL_LOCATION_ID;
  if (!key || !loc) return;
  const base = 'https://services.leadconnectorhq.com';
  const H = { Authorization: `Bearer ${key}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
  const up = await fetch(`${base}/contacts/upsert`, { method: 'POST', headers: H, body: JSON.stringify({ email: OWNER_EMAIL, locationId: loc, firstName: 'Natalie', tags: ['owner-reports'] }) }).then(r => r.json()).catch(() => null) as { contact?: { id: string } } | null;
  const contactId = up?.contact?.id;
  if (!contactId) return;
  const recLines = report.recommendations.map(r => `• [${r.severity.toUpperCase()}] ${r.area}: ${r.proposedChange}${r.gated ? ' (waiting for your approval)' : ''}`).join('<br>');
  const html = `<h2>Northgate — Daily Report, ${day}</h2><p>${report.narrative}</p>` +
    (report.recommendations.length ? `<h3>Recommended changes</h3>${recLines}` : '<p>No changes recommended today.</p>') +
    `<p style="color:#888">Gated changes are in your approval queue — nothing changes in GoHighLevel until you approve.</p>`;
  await fetch(`${base}/conversations/messages`, { method: 'POST', headers: H, body: JSON.stringify({ type: 'Email', contactId, subject: `Northgate Daily Report — ${day}`, html }) }).catch(() => {});
}

setInterval(drainLoop, 30_000);
setInterval(sweepLoop, 15 * 60_000);
setInterval(maybeRunDailyReport, 5 * 60_000); // checks every 5 min; fires once after REPORT_HOUR_ET
void drainLoop();
void sweepLoop();
void maybeRunDailyReport();

// ── Health endpoint (Railway pings this) ───────────────────────────

const port = Number(process.env.PORT ?? 8080);
createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, mode: MODE, lastDrain, lastSweep, drains, sweeps,
    }));
    return;
  }
  res.writeHead(404).end();
}).listen(port, () => {
  console.log(`Northgate OS up on :${port} — mode=${MODE}`);
  console.log('Propose mode: every outbound message becomes a review task. Nothing reaches a customer.');
});
