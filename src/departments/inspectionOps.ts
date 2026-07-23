// ── 4. AI Inspection Coordinator + 5. AI Technician Assistant ──────

import { AIEmployee } from './framework.js';

export const REQUIRED_ITEMS = [
  'exterior_photos', 'damage_closeups', 'slope_photos', 'gutter_photos',
  'penetration_photos', 'video_walkthrough', 'measurement_verification',
  'roof_material', 'roof_age', 'damage_documentation', 'interior_check',
  'insurance_info', 'customer_notes',
] as const;
export type ChecklistItem = typeof REQUIRED_ITEMS[number];

export interface InspectionRecord {
  id: string;
  opportunityId: string;
  technicianId?: string;
  scheduledAt?: Date;
  gpsArrivedAt?: Date;
  checklist: Partial<Record<ChecklistItem, { complete: boolean; at: Date; data?: unknown }>>;
  qualityScore?: number;
  submittedAt?: Date;
}

export class InspectionIncompleteError extends Error {
  constructor(public missing: ChecklistItem[]) {
    super(`INSPECTION_INCOMPLETE: missing ${missing.join(', ')}`);
  }
}

// ── Inspection Coordinator ─────────────────────────────────────────

export class InspectionCoordinator extends AIEmployee {
  readonly department = 'inspection_coordinator' as const;

  /** Reminder ladder: 48h, 24h, morning-of, en-route. */
  async sendReminder(opportunityId: string, which: '48h' | '24h' | 'morning' | 'en_route', techName?: string): Promise<void> {
    const opp = await this.store.getOpportunity(opportunityId);
    if (!opp) return;
    await this.speak(opp.customerId, opp.id, 'sms', `appointment_reminder_${which}`,
      which === 'en_route' ? { technician: techName, eta: 'shortly' } : {},
      'transactional', 'appointment they booked');
  }

  /** Greedy nearest-neighbor route optimization for a day's inspections. */
  optimizeRoute(stops: { id: string; lat: number; lng: number }[], start: { lat: number; lng: number }) {
    const remaining = [...stops];
    const route: typeof stops = [];
    let cur = start;
    while (remaining.length) {
      remaining.sort((a, b) => dist(cur, a) - dist(cur, b));
      const next = remaining.shift()!;
      route.push(next);
      cur = next;
    }
    return route;
  }
}

function dist(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  return Math.hypot(a.lat - b.lat, a.lng - b.lng);
}

// ── Technician Assistant ───────────────────────────────────────────

export class TechnicianAssistant extends AIEmployee {
  readonly department = 'technician_assistant' as const;
  private inspections = new Map<string, InspectionRecord>();

  startInspection(id: string, opportunityId: string, technicianId: string): InspectionRecord {
    const rec: InspectionRecord = { id, opportunityId, technicianId, checklist: {} };
    this.inspections.set(id, rec);
    return rec;
  }

  async gpsArrival(inspectionId: string, coords: { lat: number; lng: number }): Promise<void> {
    const rec = this.mustGet(inspectionId);
    rec.gpsArrivedAt = this.now();
    await this.emit('inspection.tech_arrived', {
      opportunityId: rec.opportunityId,
      payload: { inspectionId, coords },
    });
  }

  async completeItem(inspectionId: string, item: ChecklistItem, data?: unknown): Promise<{ remaining: ChecklistItem[] }> {
    const rec = this.mustGet(inspectionId);
    rec.checklist[item] = { complete: true, at: this.now(), data };
    return { remaining: this.missingItems(rec) };
  }

  missingItems(rec: InspectionRecord): ChecklistItem[] {
    return REQUIRED_ITEMS.filter(i => !rec.checklist[i]?.complete);
  }

  /** Quality: completeness is gated; score reflects documentation richness. */
  scoreQuality(rec: InspectionRecord): number {
    const complete = REQUIRED_ITEMS.filter(i => rec.checklist[i]?.complete).length;
    const withData = REQUIRED_ITEMS.filter(i => rec.checklist[i]?.data != null).length;
    return Math.round(((complete / REQUIRED_ITEMS.length) * 0.6 + (withData / REQUIRED_ITEMS.length) * 0.4) * 100);
  }

  /**
   * THE HARD GATE: submission throws while anything required is
   * missing, with a specific real-time prompt list for the tech.
   * (The Supabase trigger enforces the same rule at the database.)
   */
  async submit(inspectionId: string): Promise<InspectionRecord> {
    const rec = this.mustGet(inspectionId);
    const missing = this.missingItems(rec);
    if (missing.length) throw new InspectionIncompleteError(missing);

    rec.qualityScore = this.scoreQuality(rec);
    rec.submittedAt = this.now();

    await this.decide(rec.opportunityId, 'Inspection submitted complete',
      { qualityScore: rec.qualityScore }, 'All required documentation present');
    await this.emit('inspection.completed', {
      opportunityId: rec.opportunityId,
      payload: { inspectionId, qualityScore: rec.qualityScore },
    });
    return rec;
  }

  private mustGet(id: string): InspectionRecord {
    const rec = this.inspections.get(id);
    if (!rec) throw new Error(`inspection ${id} not found`);
    return rec;
  }
}
