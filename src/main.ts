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

setInterval(drainLoop, 30_000);
setInterval(sweepLoop, 15 * 60_000);
void drainLoop();
void sweepLoop();

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
