// ── Operations Director ────────────────────────────────────────────
// The routing brain. Consumes events from the bus, applies routing
// rules, transitions the journey stage (legal transitions only),
// assigns the owning department, and creates the next task.
//
// The no-stuck guarantee lives here:
//   1. every routing rule ends with a stage + owner + next task
//   2. unroutable events park the record for a human (never dropped)
//   3. the dwell-time sweep catches anything that stalls anyway

import type { Store } from '../core/store.js';
import { assertLegalTransition, isDwellViolated, stageOwner, STAGES } from '../core/stateMachine.js';
import type { BusEvent, Department, JourneyStage, Opportunity } from '../core/types.js';

export interface RouteOutcome {
  toStage: JourneyStage;
  nextAction: string;
  taskTitle: string;
  taskDetail?: Record<string, unknown>;
  reasoning: string;
}

type RoutingRule = (event: BusEvent, opp: Opportunity) => RouteOutcome | null;

// Event type → what happens next. Every rule names the next stage,
// the next action, and the task for the receiving department.
const RULES: Record<string, RoutingRule> = {
  'lead.qualified': (_e, _o) => ({
    toStage: 'outreach',
    nextAction: 'Begin outreach sequence',
    taskTitle: 'Work new scored lead',
    reasoning: 'Lead enriched, scored, and compliance-verified — ready for inside sales',
  }),
  'inbound.new_inquiry': () => ({
    toStage: 'outreach',
    nextAction: 'Qualify and book inspection',
    taskTitle: 'Follow up inbound inquiry',
    reasoning: 'Receptionist qualified a new inquiry',
  }),
  'inbound.emergency': () => ({
    toStage: 'emergency',
    nextAction: 'PAGE HUMAN ON-CALL NOW',
    taskTitle: 'EMERGENCY: page on-call human, collect address/photos',
    reasoning: 'Emergency classified — human takes over immediately, AI assists with intake',
  }),
  'inspection.booked': () => ({
    toStage: 'inspection_scheduled',
    nextAction: 'Assign technician, optimize route, run reminder ladder',
    taskTitle: 'Coordinate scheduled inspection',
    reasoning: 'Inspection booked by inside sales or receptionist',
  }),
  'inspection.tech_arrived': () => ({
    toStage: 'inspection_in_progress',
    nextAction: 'Guide on-site documentation protocol',
    taskTitle: 'Run inspection checklist to completion',
    reasoning: 'GPS arrival confirmed',
  }),
  'inspection.no_show': () => ({
    toStage: 'outreach',
    nextAction: 'Run no-show recovery sequence',
    taskTitle: 'Recover no-show: warm reschedule',
    reasoning: 'Customer missed appointment — recovery, not abandonment',
  }),
  'inspection.completed': () => ({
    toStage: 'path_decision',
    nextAction: 'Decide insurance vs retail path',
    taskTitle: 'Route completed inspection',
    reasoning: 'Documentation complete and quality-scored',
  }),
  'path.insurance_selected': () => ({
    toStage: 'claim_prep',
    nextAction: 'Verify storm, build evidence packet',
    taskTitle: 'Prepare insurance packet (human approval before submission)',
    reasoning: 'Damage pattern + storm history support a claim path',
  }),
  'path.retail_selected': () => ({
    toStage: 'proposal',
    nextAction: 'Build and deliver proposal',
    taskTitle: 'Create proposal from inspection + price book',
    reasoning: 'Retail path appropriate (no supportable claim or customer preference)',
  }),
  'claim.packet_approved_and_submitted': () => ({
    toStage: 'claim_active',
    nextAction: 'Track claim milestones, schedule adjuster',
    taskTitle: 'Monitor active claim',
    reasoning: 'Human approved packet; claim filed',
  }),
  'claim.approved': () => ({
    toStage: 'proposal',
    nextAction: 'Build proposal from approved scope',
    taskTitle: 'Convert approved claim to contract',
    reasoning: 'Carrier approved — move to contracting',
  }),
  'claim.denied': () => ({
    toStage: 'path_decision',
    nextAction: 'Present retail options honestly',
    taskTitle: 'Claim denied: evaluate retail fallback with customer',
    reasoning: 'Denial is not a dead end — customer still has a damaged roof',
  }),
  'contract.signed_deposit_verified': () => ({
    toStage: 'production_queue',
    nextAction: 'Order materials, schedule crew, verify permits',
    taskTitle: 'Stand up production for signed job',
    reasoning: 'Contract signed and deposit cleared',
  }),
  'proposal.gone_cold': () => ({
    toStage: 'nurture',
    nextAction: 'Long-cycle nurture cadence',
    taskTitle: 'Move cold proposal to nurture',
    reasoning: 'No engagement after full follow-up sequence — nurture forever, never dead',
  }),
  'production.ready_to_install': () => ({
    toStage: 'installing',
    nextAction: 'Track install, daily updates to customer',
    taskTitle: 'Monitor installation',
    reasoning: 'Materials delivered, crew scheduled, permits satisfied',
  }),
  'production.completed_walkthrough_passed': () => ({
    toStage: 'invoicing',
    nextAction: 'Generate final invoice',
    taskTitle: 'Invoice completed job',
    reasoning: 'Punch list cleared, walkthrough passed, completion verified',
  }),
  'invoice.paid_in_full': () => ({
    toStage: 'warranty_active',
    nextAction: 'Register warranties, start touchpoint calendar',
    taskTitle: 'Activate warranty relationship',
    reasoning: 'Zero balance — lifetime relationship begins; review request fires now',
  }),
  'nurture.reactivation_signal': () => ({
    toStage: 'outreach',
    nextAction: 'Re-engage with storm/context-triggered outreach',
    taskTitle: 'Reactivate nurture lead',
    reasoning: 'New storm hit property or customer re-engaged',
  }),
  'emergency.human_acknowledged': () => ({
    toStage: 'inspection_scheduled',
    nextAction: 'Emergency inspection dispatched',
    taskTitle: 'Coordinate emergency inspection',
    reasoning: 'Human acknowledged; emergency slot booked',
  }),
  'human.unparked': (e) => {
    const to = (e.payload['returnToStage'] ?? 'outreach') as JourneyStage;
    return {
      toStage: to,
      nextAction: `Resume at ${to} per human instruction`,
      taskTitle: `Resume workflow at ${to}`,
      reasoning: `Human resolved the parked issue and returned the record to ${to}`,
    };
  },
};

export class OperationsDirector {
  constructor(private store: Store, private now: () => Date = () => new Date()) {}

  /** Process one event off the bus. Returns what happened. */
  async processEvent(event: BusEvent): Promise<{ routed: boolean; outcome?: RouteOutcome; parked?: boolean }> {
    try {
      if (!event.opportunityId) {
        // System-level events (health, marketing signals) are consumed
        // by their own departments; the director only routes journeys.
        await this.store.markEventProcessed(event.id!);
        return { routed: false };
      }
      const opp = await this.store.getOpportunity(event.opportunityId);
      if (!opp) throw new Error(`opportunity ${event.opportunityId} not found`);

      const rule = RULES[event.eventType];
      if (!rule) {
        // Unknown event on a journey: park it — never drop it.
        await this.park(opp, `No routing rule for event '${event.eventType}'`);
        await this.store.markEventProcessed(event.id!, `unroutable: ${event.eventType}`);
        return { routed: false, parked: true };
      }

      const outcome = rule(event, opp);
      if (!outcome) {
        await this.store.markEventProcessed(event.id!);
        return { routed: false };
      }

      await this.transition(opp, outcome, event);
      await this.store.markEventProcessed(event.id!);
      return { routed: true, outcome };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.store.markEventProcessed(event.id!, msg);
      // A failed routing is itself a parkable failure — recoverable, never silent.
      if (event.opportunityId) {
        const opp = await this.store.getOpportunity(event.opportunityId);
        if (opp) await this.park(opp, `Routing failed: ${msg}`);
      }
      return { routed: false, parked: true };
    }
  }

  private async transition(opp: Opportunity, outcome: RouteOutcome, event: BusEvent): Promise<void> {
    assertLegalTransition(opp.stage, outcome.toStage);
    const before = { stage: opp.stage, owner: opp.owningDepartment };

    opp.stage = outcome.toStage;
    opp.stageEnteredAt = this.now();
    opp.owningDepartment = stageOwner(outcome.toStage);
    opp.nextAction = outcome.nextAction;
    await this.store.saveOpportunity(opp);

    await this.store.createTask({
      opportunityId: opp.id,
      owner: opp.owningDepartment,
      title: outcome.taskTitle,
      detail: { ...outcome.taskDetail, triggeringEvent: event.eventType },
      createdBy: 'operations_director',
      escalateAfter: Number.isFinite(STAGES[outcome.toStage].maxDwellMs)
        ? new Date(this.now().getTime() + STAGES[outcome.toStage].maxDwellMs)
        : undefined,
    });

    await this.store.recordDecision({
      actor: 'operations_director',
      opportunityId: opp.id,
      decision: `Routed ${before.stage} -> ${outcome.toStage} (owner: ${opp.owningDepartment})`,
      inputs: { event: event.eventType, payload: event.payload },
      reasoning: outcome.reasoning,
    });

    await this.store.appendAudit({
      actor: 'operations_director',
      action: `journey.transition:${before.stage}->${outcome.toStage}`,
      entityTable: 'opportunities',
      entityId: opp.id,
      before,
      after: { stage: opp.stage, owner: opp.owningDepartment, nextAction: opp.nextAction },
    });
  }

  /** Park a record for a human — the safety net, never a black hole. */
  async park(opp: Opportunity, reason: string): Promise<void> {
    if (opp.stage === 'parked_needs_human') return;
    const from = opp.stage;
    assertLegalTransition(from, 'parked_needs_human');
    opp.stage = 'parked_needs_human';
    opp.stageEnteredAt = this.now();
    opp.owningDepartment = 'executive_operations';
    opp.nextAction = `HUMAN NEEDED: ${reason} (was in ${from})`;
    await this.store.saveOpportunity(opp);
    await this.store.createTask({
      opportunityId: opp.id,
      owner: 'human',
      title: `Resolve parked record: ${reason}`,
      detail: { previousStage: from },
      createdBy: 'operations_director',
    });
    await this.store.appendAudit({
      actor: 'operations_director',
      action: 'journey.parked',
      entityTable: 'opportunities',
      entityId: opp.id,
      before: { stage: from },
      after: { reason },
    });
  }

  /** Drain the event bus. */
  async drain(maxEvents = 1000): Promise<number> {
    let processed = 0;
    while (processed < maxEvents) {
      const event = await this.store.nextUnprocessedEvent();
      if (!event) break;
      await this.processEvent(event);
      processed++;
    }
    return processed;
  }

  /**
   * The dwell-time sweep (run on a schedule): finds every opportunity
   * that has sat in its stage past the limit and raises a stuck alert.
   */
  async sweepStuck(): Promise<Opportunity[]> {
    const now = this.now();
    const all = await this.store.listAllOpportunities();
    const stuck = all.filter(o =>
      !o.closedReason && isDwellViolated(o.stage, o.stageEnteredAt, now));
    for (const opp of stuck) {
      await this.store.appendEvent({
        eventType: 'ops.stuck_opportunity',
        opportunityId: opp.id,
        customerId: opp.customerId,
        actor: 'executive_operations',
        payload: {
          stage: opp.stage,
          enteredAt: opp.stageEnteredAt.toISOString(),
          note: STAGES[opp.stage].escalationNote,
        },
      });
      await this.store.createTask({
        opportunityId: opp.id,
        owner: stageOwner(opp.stage),
        title: `STUCK: ${STAGES[opp.stage].escalationNote}`,
        detail: { stage: opp.stage, dwellSince: opp.stageEnteredAt.toISOString() },
        createdBy: 'executive_operations',
      });
    }
    return stuck;
  }
}

/** Departments never call each other — they emit events. */
export async function emit(
  store: Store,
  eventType: string,
  actor: Department,
  opts: { opportunityId?: string; customerId?: string; payload?: Record<string, unknown> } = {},
): Promise<BusEvent> {
  return store.appendEvent({
    eventType,
    actor,
    opportunityId: opts.opportunityId,
    customerId: opts.customerId,
    payload: opts.payload ?? {},
  });
}
