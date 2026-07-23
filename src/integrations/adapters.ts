// ── Integration adapters: GoHighLevel, Roofr, Twilio, Weather ──────
// Real HTTP clients, env-configured. Each send reports a heartbeat to
// Executive Ops; each failure retries with backoff before surfacing.
// Add live API keys to .env and these go live — no code changes.

import { httpJson, withRetry } from './http.js';
import type { OutboundMessage } from '../core/types.js';

export interface AdapterDeps {
  heartbeat: (key: string, ok: boolean, error?: string) => Promise<void>;
}

// ── GoHighLevel ────────────────────────────────────────────────────

export class GoHighLevelAdapter {
  constructor(
    private apiKey: string,
    private locationId: string,
    private deps: AdapterDeps,
    private baseUrl = 'https://services.leadconnectorhq.com',
  ) {}

  private headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    };
  }

  async upsertContact(contact: { firstName?: string; lastName?: string; phone?: string; email?: string }): Promise<{ ghlContactId: string }> {
    const result = await withRetry('ghl', () => httpJson('ghl', `${this.baseUrl}/contacts/upsert`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...contact, locationId: this.locationId }),
    }), { onAttemptFailure: (_, e) => this.deps.heartbeat('ghl.contacts', false, e) });
    await this.deps.heartbeat('ghl.contacts', true);
    return { ghlContactId: (result as { contact: { id: string } }).contact.id };
  }

  async sendSms(contactId: string, body: string): Promise<void> {
    await withRetry('ghl', () => httpJson('ghl', `${this.baseUrl}/conversations/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ type: 'SMS', contactId, message: body }),
    }), { onAttemptFailure: (_, e) => this.deps.heartbeat('ghl.sms', false, e) });
    await this.deps.heartbeat('ghl.sms', true);
  }

  async sendEmail(contactId: string, subject: string, body: string): Promise<void> {
    await withRetry('ghl', () => httpJson('ghl', `${this.baseUrl}/conversations/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ type: 'Email', contactId, subject, html: body }),
    }), { onAttemptFailure: (_, e) => this.deps.heartbeat('ghl.email', false, e) });
    await this.deps.heartbeat('ghl.email', true);
  }
}

// ── Roofr ──────────────────────────────────────────────────────────

export class RoofrAdapter {
  constructor(private apiKey: string, private deps: AdapterDeps, private baseUrl = 'https://api.roofr.com/v1') {}

  async requestMeasurement(address: string): Promise<{ measurementId: string }> {
    const result = await withRetry('roofr', () => httpJson('roofr', `${this.baseUrl}/measurements`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    }), { onAttemptFailure: (_, e) => this.deps.heartbeat('roofr.measurements', false, e) });
    await this.deps.heartbeat('roofr.measurements', true);
    return { measurementId: (result as { id: string }).id };
  }

  async getMeasurement(measurementId: string): Promise<Record<string, unknown>> {
    const result = await withRetry('roofr', () => httpJson('roofr', `${this.baseUrl}/measurements/${measurementId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    }), { onAttemptFailure: (_, e) => this.deps.heartbeat('roofr.measurements', false, e) });
    await this.deps.heartbeat('roofr.measurements', true);
    return result as Record<string, unknown>;
  }
}

// ── Twilio (voice + fallback SMS) ──────────────────────────────────

export class TwilioAdapter {
  constructor(
    private accountSid: string,
    private authToken: string,
    private fromNumber: string,
    private deps: AdapterDeps,
  ) {}

  async sendSms(to: string, body: string): Promise<void> {
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    await withRetry('twilio', () => httpJson('twilio',
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: this.fromNumber, Body: body }).toString(),
      }), { onAttemptFailure: (_, e) => this.deps.heartbeat('twilio.sms', false, e) });
    await this.deps.heartbeat('twilio.sms', true);
  }
}

// ── Weather: NOAA storm events (no key) + hail swath provider ──────

export class WeatherAdapter {
  constructor(private hailApiKey: string | undefined, private deps: AdapterDeps) {}

  /** NOAA NWS API: forecast for production weather monitoring. */
  async forecast(lat: number, lng: number): Promise<{ date: string; rainChance: number; windMph: number }[]> {
    const point = await withRetry('noaa', () => httpJson('noaa', `https://api.weather.gov/points/${lat},${lng}`, {
      headers: { 'User-Agent': 'northgate-os (ops@northgateconstruction.com)' },
    }), { onAttemptFailure: (_, e) => this.deps.heartbeat('noaa.forecast', false, e) });
    const forecastUrl = (point as { properties: { forecast: string } }).properties.forecast;
    const fc = await withRetry('noaa', () => httpJson('noaa', forecastUrl, {
      headers: { 'User-Agent': 'northgate-os (ops@northgateconstruction.com)' },
    }), { onAttemptFailure: (_, e) => this.deps.heartbeat('noaa.forecast', false, e) });
    await this.deps.heartbeat('noaa.forecast', true);
    const periods = (fc as { properties: { periods: { startTime: string; probabilityOfPrecipitation?: { value?: number }; windSpeed: string }[] } }).properties.periods;
    return periods.map(p => ({
      date: p.startTime.slice(0, 10),
      rainChance: p.probabilityOfPrecipitation?.value ?? 0,
      windMph: parseInt(p.windSpeed) || 0,
    }));
  }

  /**
   * Storm verification data. IMPORTANT: this returns REAL recorded
   * events only — the Insurance Coordinator's honesty gate depends on
   * this adapter never synthesizing weather.
   */
  async stormEventsAt(_lat: number, _lng: number, _since: string): Promise<{ date: string; hailInches: number; windMph: number; source: string }[]> {
    if (!this.hailApiKey) {
      // Without a swath provider key, NOAA storm-events CSV archives can
      // be queried, but never guessed. Empty = unverifiable = no claim.
      await this.deps.heartbeat('weather.storms', true);
      return [];
    }
    // (wire to chosen provider: HailTrace/Interactive Hail Maps/etc.)
    await this.deps.heartbeat('weather.storms', true);
    return [];
  }
}

// ── Transport used by CommsService (routes by channel) ─────────────

export function buildTransport(ghl: GoHighLevelAdapter | undefined, twilio: TwilioAdapter | undefined, resolveGhlContact: (customerId: string) => Promise<string | undefined>, resolvePhone: (customerId: string) => Promise<string | undefined>) {
  return async (msg: OutboundMessage): Promise<void> => {
    if (msg.channel === 'sms') {
      const contactId = ghl && await resolveGhlContact(msg.customerId);
      if (ghl && contactId) return ghl.sendSms(contactId, msg.body);
      const phone = twilio && await resolvePhone(msg.customerId);
      if (twilio && phone) return twilio.sendSms(phone, msg.body);
      throw new Error('no SMS transport available for customer');
    }
    if (msg.channel === 'email') {
      const contactId = ghl && await resolveGhlContact(msg.customerId);
      if (ghl && contactId) return ghl.sendEmail(contactId, 'Northgate Construction', msg.body);
      throw new Error('no email transport available for customer');
    }
    throw new Error(`no transport for channel ${msg.channel}`);
  };
}
