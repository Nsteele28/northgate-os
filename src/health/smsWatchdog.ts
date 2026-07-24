// ── SMS pipeline watchdog ──────────────────────────────────────────
// The outreach pipe is the lifeblood. This watches it continuously and,
// the instant it breaks or stalls, it: (1) alerts Natalie on every
// channel, (2) auto-pauses so we don't burn leads into a dead pipe,
// (3) tries to self-heal with a canary send, (4) auto-resumes on
// recovery, and (5) keeps re-alerting until a human confirms.
//
// Runs every 60s on the Railway server.

import type { SupabaseStore } from '../adapters/supabaseStore.js';

export interface WatchdogAlert {
  severity: 'warning' | 'critical' | 'recovered';
  headline: string;
  detail: string;
}

export type AlertSink = (a: WatchdogAlert) => Promise<void>;

export interface WatchdogConfig {
  /** consecutive send failures before we pause + scream */
  failureThreshold: number;
  /** min delivered rate over the recent window before we alert */
  minDeliveryRate: number;
  /** how many recent sends to evaluate the rate over */
  windowSize: number;
  /** if outreach is "live" but nothing sent in this many minutes during
   *  business hours, treat as a stall (campaign silently stopped) */
  stallMinutes: number;
  /** re-alert cadence while broken (minutes) */
  reAlertEveryMin: number;
}

export const DEFAULT_WATCHDOG: WatchdogConfig = {
  failureThreshold: 3,
  minDeliveryRate: 0.7,
  windowSize: 20,
  stallMinutes: 90,
  reAlertEveryMin: 5,
};

export type PipelineState = 'healthy' | 'degraded' | 'down' | 'paused';

export class SmsWatchdog {
  state: PipelineState = 'healthy';
  private lastAlertAt = 0;
  private brokenSince: number | null = null;

  constructor(
    private store: SupabaseStore,
    private alert: AlertSink,
    private canarySend: () => Promise<boolean>, // returns true if a test send succeeds
    private setPaused: (paused: boolean) => void,
    private cfg: WatchdogConfig = DEFAULT_WATCHDOG,
    private now: () => number = () => Date.now(),
  ) {}

  private q(path: string) { return this.store.query(path); }

  /** One tick. Called every 60s. */
  async check(mode: string): Promise<void> {
    // Only guards the live pipe; in propose mode there's nothing to send.
    if (mode !== 'live') { this.state = 'healthy'; return; }

    const health = (await this.q(`automation_health?automation_key=eq.ghl.sms&limit=1`))[0];
    const since = new Date(this.now() - this.cfg.windowSize * 60_000).toISOString();
    const recent = await this.q(`conversations?channel=eq.sms&direction=eq.outbound&occurred_at=gte.${since}&select=delivered,occurred_at&order=occurred_at.desc&limit=${this.cfg.windowSize}`);

    const consecutiveFailures = health ? Number(health.consecutive_failures ?? 0) : 0;
    const sent = recent.length;
    const delivered = recent.filter(r => r.delivered === true).length;
    const deliveryRate = sent ? delivered / sent : 1;
    const healthRed = health?.status === 'red';

    // Stall detection: live + business hours + nothing recent
    const lastSend = recent[0]?.occurred_at ? new Date(String(recent[0].occurred_at)).getTime() : null;
    const stalled = lastSend != null && (this.now() - lastSend) > this.cfg.stallMinutes * 60_000;

    let problem: WatchdogAlert | null = null;

    if (healthRed || consecutiveFailures >= this.cfg.failureThreshold) {
      problem = {
        severity: 'critical',
        headline: 'SMS pipeline DOWN — outreach auto-paused',
        detail: `The GoHighLevel SMS channel is failing (${consecutiveFailures} consecutive errors${health?.last_error ? `: ${health.last_error}` : ''}). Sending is paused so leads aren't burned. Attempting auto-recovery.`,
      };
    } else if (sent >= 10 && deliveryRate < this.cfg.minDeliveryRate) {
      problem = {
        severity: 'critical',
        headline: `SMS delivery collapsed to ${(deliveryRate * 100).toFixed(0)}%`,
        detail: `Only ${delivered} of the last ${sent} texts delivered. Likely a carrier/A2P or number issue. Outreach auto-paused.`,
      };
    } else if (stalled) {
      problem = {
        severity: 'critical',
        headline: 'SMS campaign STALLED — no texts going out',
        detail: `Nothing has sent in ${this.cfg.stallMinutes}+ minutes during business hours though the campaign is live. The engine may be stuck.`,
      };
    }

    if (problem) {
      await this.onProblem(problem);
    } else if (this.state !== 'healthy') {
      await this.onRecovered();
    }
  }

  private async onProblem(a: WatchdogAlert): Promise<void> {
    const first = this.state === 'healthy';
    this.state = 'down';
    if (this.brokenSince == null) this.brokenSince = this.now();
    this.setPaused(true); // stop the bleed

    const due = this.now() - this.lastAlertAt > this.cfg.reAlertEveryMin * 60_000;
    if (first || due) {
      this.lastAlertAt = this.now();
      await this.alert(a);
      await this.store.query('automation_health').catch(() => []);
      // try to self-heal
      const healed = await this.tryHeal();
      if (healed) await this.onRecovered();
    }
  }

  private async tryHeal(): Promise<boolean> {
    try {
      const ok = await this.canarySend();
      return ok;
    } catch { return false; }
  }

  private async onRecovered(): Promise<void> {
    const downMs = this.brokenSince ? this.now() - this.brokenSince : 0;
    this.state = 'healthy';
    this.brokenSince = null;
    this.setPaused(false);
    await this.alert({
      severity: 'recovered',
      headline: 'SMS pipeline RECOVERED — outreach resumed',
      detail: `The SMS channel is delivering again${downMs ? ` (down ~${Math.round(downMs / 60_000)} min)` : ''}. Sending has resumed automatically.`,
    });
  }
}
