// ── Journey state machine ──────────────────────────────────────────
// Every opportunity is in exactly one stage. Every stage has one
// owning department and a maximum dwell time. Transitions not listed
// here are illegal and throw.

import type { Department, JourneyStage } from './types.js';

export interface StageDef {
  owner: Department;
  /** ms an opportunity may sit here before a stuck-alert fires */
  maxDwellMs: number;
  escalationNote: string;
  legalNext: JourneyStage[];
}

const H = 3_600_000, D = 24 * H;

export const STAGES: Record<JourneyStage, StageDef> = {
  new_lead: {
    owner: 'lead_intelligence', maxDwellMs: 1 * D,
    escalationNote: 'Lead not enriched/scored within a day',
    legalNext: ['outreach', 'parked_needs_human'],
  },
  inbound_contact: {
    owner: 'receptionist', maxDwellMs: 1 * H,
    escalationNote: 'Inbound contact not routed within an hour',
    legalNext: ['outreach', 'inspection_scheduled', 'emergency', 'parked_needs_human'],
  },
  outreach: {
    owner: 'inside_sales', maxDwellMs: 30 * D,
    escalationNote: 'No outreach outcome in 30 days — verify cadence is running',
    legalNext: ['inspection_scheduled', 'nurture', 'parked_needs_human'],
  },
  inspection_scheduled: {
    owner: 'inspection_coordinator', maxDwellMs: 14 * D,
    escalationNote: 'Inspection unbooked/unconfirmed too long',
    legalNext: ['inspection_in_progress', 'outreach', 'parked_needs_human'], // outreach = no-show recovery
  },
  inspection_in_progress: {
    owner: 'technician_assistant', maxDwellMs: 12 * H,
    escalationNote: 'Inspection started but never completed',
    legalNext: ['path_decision', 'inspection_scheduled', 'parked_needs_human'],
  },
  path_decision: {
    owner: 'operations_director', maxDwellMs: 1 * D,
    escalationNote: 'Completed inspection not routed to insurance/retail',
    legalNext: ['claim_prep', 'proposal', 'parked_needs_human'],
  },
  claim_prep: {
    owner: 'insurance_coordinator', maxDwellMs: 7 * D,
    escalationNote: 'Packet preparation stalled',
    legalNext: ['claim_active', 'path_decision', 'parked_needs_human'],
  },
  claim_active: {
    owner: 'insurance_coordinator', maxDwellMs: 21 * D,
    escalationNote: 'No claim movement past carrier norm',
    legalNext: ['proposal', 'path_decision', 'parked_needs_human'], // path_decision = denial → retail fallback
  },
  proposal: {
    owner: 'retail_sales', maxDwellMs: 21 * D,
    escalationNote: 'Proposal aging without close or follow-up outcome',
    legalNext: ['production_queue', 'nurture', 'parked_needs_human'],
  },
  production_queue: {
    owner: 'production_manager', maxDwellMs: 30 * D,
    escalationNote: 'Signed job not scheduled for production',
    legalNext: ['installing', 'parked_needs_human'],
  },
  installing: {
    owner: 'production_manager', maxDwellMs: 14 * D,
    escalationNote: 'Install running long',
    legalNext: ['invoicing', 'parked_needs_human'],
  },
  invoicing: {
    owner: 'collections_manager', maxDwellMs: 45 * D,
    escalationNote: 'Balance outstanding past collections norm',
    legalNext: ['warranty_active', 'parked_needs_human'],
  },
  warranty_active: {
    owner: 'warranty_department', maxDwellMs: Number.POSITIVE_INFINITY, // permanent stage, own timers
    escalationNote: '',
    legalNext: ['outreach', 'parked_needs_human'], // outreach = new opportunity for same customer handled via new record; repair via warranty
  },
  nurture: {
    owner: 'inside_sales', maxDwellMs: 120 * D,
    escalationNote: 'Nurture touch overdue',
    legalNext: ['outreach', 'parked_needs_human'],
  },
  emergency: {
    owner: 'receptionist', maxDwellMs: 15 * 60_000,
    escalationNote: 'EMERGENCY not acknowledged by a human',
    legalNext: ['inspection_scheduled', 'outreach', 'parked_needs_human'],
  },
  parked_needs_human: {
    owner: 'executive_operations', maxDwellMs: 1 * D,
    escalationNote: 'Parked record awaiting human too long',
    legalNext: [
      'new_lead', 'inbound_contact', 'outreach', 'inspection_scheduled',
      'inspection_in_progress', 'path_decision', 'claim_prep', 'claim_active',
      'proposal', 'production_queue', 'installing', 'invoicing',
      'warranty_active', 'nurture',
    ], // humans can return a parked record to any operational stage
  },
};

export class IllegalTransitionError extends Error {
  constructor(from: JourneyStage, to: JourneyStage) {
    super(`ILLEGAL_TRANSITION: ${from} -> ${to}`);
  }
}

export function assertLegalTransition(from: JourneyStage, to: JourneyStage): void {
  if (!STAGES[from].legalNext.includes(to)) throw new IllegalTransitionError(from, to);
}

export function stageOwner(stage: JourneyStage): Department {
  return STAGES[stage].owner;
}

export function isDwellViolated(stage: JourneyStage, enteredAt: Date, now: Date): boolean {
  const def = STAGES[stage];
  if (!Number.isFinite(def.maxDwellMs)) return false;
  return now.getTime() - enteredAt.getTime() > def.maxDwellMs;
}
