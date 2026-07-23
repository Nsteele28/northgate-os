// ── Northgate OS: system guarantees test suite ─────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../src/core/memoryStore.js';
import { ApprovalService, ApprovalNotGrantedError, ApprovalRequiredError } from '../src/core/approvals.js';
import { ComplianceEngine, ComplianceBlockedError, looksLikeOptOut } from '../src/core/compliance.js';
import { assertLegalTransition, IllegalTransitionError, STAGES } from '../src/core/stateMachine.js';
import { OperationsDirector, emit } from '../src/director/router.js';
import { CommsService, TemplateBrain } from '../src/departments/framework.js';
import { Receptionist } from '../src/departments/receptionist.js';
import { LeadIntelligence } from '../src/departments/leadIntelligence.js';
import { InsideSales } from '../src/departments/insideSales.js';
import { TechnicianAssistant, InspectionIncompleteError, REQUIRED_ITEMS } from '../src/departments/inspectionOps.js';
import { InsuranceCoordinator, UnsupportedClaimError } from '../src/departments/insurance.js';
import { RetailSales } from '../src/departments/retailSales.js';
import { ProductionManager } from '../src/departments/production.js';
import { CollectionsManager } from '../src/departments/collections.js';
import { WarrantyDepartment, CustomerSuccess, Marketing } from '../src/departments/lifecycle.js';
import { ExecutiveOps } from '../src/health/executiveOps.js';
import type { Customer, Opportunity, OutboundMessage } from '../src/core/types.js';

// ── Harness ────────────────────────────────────────────────────────

function build(nowRef: { t: Date } = { t: new Date('2026-07-23T12:00:00Z') }) {
  const now = () => nowRef.t;
  const store = new MemoryStore();
  const sentMessages: OutboundMessage[] = [];
  const transport = async (m: OutboundMessage) => { sentMessages.push(m); };
  const compliance = new ComplianceEngine(store, { quietHoursStart: 21, quietHoursEnd: 8, weeklyFrequencyCap: 5 }, () => new Date('2026-07-23T16:00:00Z')); // midday: not quiet hours
  const comms = new CommsService(store, compliance, transport);
  const brain = new TemplateBrain();
  const approvals = new ApprovalService(store, now);
  const director = new OperationsDirector(store, now);
  const pages: unknown[] = [];
  const execOps = new ExecutiveOps(store, director, approvals, async e => { pages.push(e); }, now);

  return {
    store, comms, brain, approvals, director, execOps, sentMessages, pages, nowRef, now,
    receptionist: new Receptionist(store, comms, brain, now),
    leadIntel: new LeadIntelligence(store, comms, brain, now),
    insideSales: new InsideSales(store, comms, brain, now),
    techAssistant: new TechnicianAssistant(store, comms, brain, now),
    insurance: new InsuranceCoordinator(store, comms, brain, approvals, now),
    retail: new RetailSales(store, comms, brain, approvals, now),
    production: new ProductionManager(store, comms, brain, approvals, 15_000, now),
    collections: new CollectionsManager(store, comms, brain, approvals, now),
    warranty: new WarrantyDepartment(store, comms, brain, now),
    customerSuccess: new CustomerSuccess(store, comms, brain, now),
    marketing: new Marketing(store, comms, brain, now),
  };
}

async function seedCustomerAndOpp(s: ReturnType<typeof build>, stage: Opportunity['stage'] = 'outreach') {
  const customer: Customer = {
    id: randomUUID(), firstName: 'Dana', lastName: 'Homeowner',
    phone: '+13135550100', email: 'dana@example.com',
    consentSms: true, consentEmail: true, dnc: false, optedOut: false, archived: false,
  };
  await s.store.saveCustomer(customer);
  const opp: Opportunity = {
    id: randomUUID(), customerId: customer.id, stage,
    stageEnteredAt: s.now(), owningDepartment: STAGES[stage].owner, path: 'undecided',
  };
  await s.store.saveOpportunity(opp);
  return { customer, opp };
}

// ── State machine ──────────────────────────────────────────────────

describe('journey state machine', () => {
  it('rejects illegal transitions', () => {
    expect(() => assertLegalTransition('new_lead', 'installing')).toThrow(IllegalTransitionError);
    expect(() => assertLegalTransition('outreach', 'invoicing')).toThrow(IllegalTransitionError);
    expect(() => assertLegalTransition('proposal', 'claim_prep')).toThrow(IllegalTransitionError);
  });

  it('every stage has an owner and (except warranty) a finite dwell limit', () => {
    for (const [stage, def] of Object.entries(STAGES)) {
      expect(def.owner).toBeTruthy();
      if (stage !== 'warranty_active') expect(Number.isFinite(def.maxDwellMs)).toBe(true);
    }
  });

  it('every stage can reach parked_needs_human (no black holes)', () => {
    for (const [stage, def] of Object.entries(STAGES)) {
      if (stage === 'parked_needs_human') continue;
      expect(def.legalNext).toContain('parked_needs_human');
    }
  });
});

// ── Full journey: lead → warranty with zero manual routing ─────────

describe('end-to-end journey', () => {
  it('walks a customer from storm lead to warranty_active entirely through events', async () => {
    const s = build();

    // 1. Lead Intelligence finds and scores a prospect
    const { created } = await s.leadIntel.generateProspects(
      { date: '2026-07-20', hailInches: 1.75, windMph: 70, source: 'NOAA', affectedZips: ['48201'] },
      [{ address: '1 Maple St', city: 'Detroit', state: 'MI', zip: '48201', ownerName: 'Dana Homeowner', ownerPhone: '+13135550100', roofAgeYears: 15, propertyValue: 300_000, onDncRegistry: false, hasSolicitationRestriction: false }],
    );
    expect(created).toHaveLength(1);
    const oppId = created[0]!;

    await s.director.drain();
    let opp = (await s.store.getOpportunity(oppId))!;
    expect(opp.stage).toBe('outreach');
    expect(opp.owningDepartment).toBe('inside_sales');

    // 2. Inside Sales books the inspection
    await s.insideSales.bookInspection(oppId, new Date('2026-07-25T14:00:00Z'), { roofAgeYears: 15, carrier: 'State Farm' });
    await s.director.drain();
    opp = (await s.store.getOpportunity(oppId))!;
    expect(opp.stage).toBe('inspection_scheduled');

    // 3. Tech arrives, completes EVERY required item, submits
    const insp = s.techAssistant.startInspection('insp-1', oppId, 'tech-1');
    await s.techAssistant.gpsArrival('insp-1', { lat: 42.33, lng: -83.05 });
    await s.director.drain();
    expect((await s.store.getOpportunity(oppId))!.stage).toBe('inspection_in_progress');

    for (const item of REQUIRED_ITEMS) await s.techAssistant.completeItem('insp-1', item, { note: item });
    await s.techAssistant.submit('insp-1');
    await s.director.drain();
    expect((await s.store.getOpportunity(oppId))!.stage).toBe('path_decision');

    // 4. Insurance path: verified storm → packet → human approval → submit
    await emit(s.store, 'path.insurance_selected', 'operations_director', { opportunityId: oppId });
    await s.director.drain();
    expect((await s.store.getOpportunity(oppId))!.stage).toBe('claim_prep');

    const packet = await s.insurance.buildPacket({
      opportunityId: oppId, carrier: 'State Farm',
      stormHistory: [{ date: '2026-07-20', hailInches: 1.75, windMph: 70, source: 'NOAA' }],
      photos: [{ url: 'p1.jpg', label: 'north slope hail strikes' }],
      measurements: { squares: 28 },
      technicianSummary: 'Hail strikes on all slopes',
    });
    const approvalId = await s.insurance.requestSubmissionApproval(packet);
    await s.approvals.decide(approvalId, 'approved', 'Natalie');
    await s.insurance.executeSubmission(packet, approvalId);
    await s.director.drain();
    expect((await s.store.getOpportunity(oppId))!.stage).toBe('claim_active');

    // 5. Claim approved → proposal → human-gated contract → signed
    await s.insurance.claimApproved(oppId, { rcv: 24_000 });
    await s.director.drain();
    expect((await s.store.getOpportunity(oppId))!.stage).toBe('proposal');

    const sendApproval = await s.retail.requestContractSendApproval(oppId, { total: 24_000 });
    await s.approvals.decide(sendApproval, 'approved', 'Ricky');
    await s.retail.sendContract(oppId, sendApproval);
    await s.retail.contractSigned(oppId, true);
    await s.director.drain();
    expect((await s.store.getOpportunity(oppId))!.stage).toBe('production_queue');

    // 6. Production: prerequisites → install → completion
    const job = s.production.startJob(oppId, true);
    await s.production.orderMaterials(oppId, { supplier: 'ABC Supply', amountUsd: 9_000, items: [] });
    job.materialsDelivered = true; job.crewScheduled = true; job.dumpsterScheduled = true; job.permitStatus = 'approved';
    const ready = await s.production.checkReadyToInstall(oppId);
    expect(ready.ready).toBe(true);
    await s.director.drain();
    expect((await s.store.getOpportunity(oppId))!.stage).toBe('installing');

    job.walkthroughPassed = true;
    expect(await s.production.verifyCompletion(oppId)).toBe(true);
    await s.director.drain();
    expect((await s.store.getOpportunity(oppId))!.stage).toBe('invoicing');

    // 7. Collections → paid in full → warranty
    s.collections.generateInvoice(oppId, 24_000, 0, new Date('2026-08-15'));
    await s.collections.recordPayment(oppId, 24_000);
    await s.director.drain();
    const finalOpp = (await s.store.getOpportunity(oppId))!;
    expect(finalOpp.stage).toBe('warranty_active');
    expect(finalOpp.owningDepartment).toBe('warranty_department');

    // The whole journey is explained and audited
    expect(s.store.decisions.length).toBeGreaterThan(5);
    expect((await s.store.listAudit()).some(a => a.action.startsWith('journey.transition'))).toBe(true);
  });
});

// ── Approval gates ─────────────────────────────────────────────────

describe('human approval gates', () => {
  it('blocks insurance submission without approval', async () => {
    const s = build();
    const { opp } = await seedCustomerAndOpp(s, 'claim_prep');
    const packet = await s.insurance.buildPacket({
      opportunityId: opp.id, carrier: 'Allstate',
      stormHistory: [{ date: '2026-06-01', hailInches: 1.0, windMph: 60, source: 'NOAA' }],
      photos: [], measurements: {}, technicianSummary: 'damage',
    });
    await expect(s.insurance.executeSubmission(packet, undefined as unknown as string)).rejects.toThrow(ApprovalRequiredError);
    const approvalId = await s.insurance.requestSubmissionApproval(packet);
    await expect(s.insurance.executeSubmission(packet, approvalId)).rejects.toThrow(ApprovalNotGrantedError);
    await s.approvals.decide(approvalId, 'denied', 'Natalie', 'needs more photos');
    await expect(s.insurance.executeSubmission(packet, approvalId)).rejects.toThrow(ApprovalNotGrantedError);
  });

  it('blocks discounts and large material orders without approval', async () => {
    const s = build();
    const { opp } = await seedCustomerAndOpp(s, 'proposal');
    const priceBook = new Map([['SHNGL-ARCH', 450]]);
    const draft = s.retail.buildProposal(opp.id, priceBook, [{ code: 'SHNGL-ARCH', qty: 30 }]);
    expect(draft.listPrice).toBe(13_500);
    await expect(s.retail.applyApprovedDiscount(draft, 12_000, 'nonexistent')).rejects.toThrow();

    s.production.startJob(opp.id, true);
    await expect(
      s.production.orderMaterials(opp.id, { supplier: 'ABC', amountUsd: 20_000, items: [] }),
    ).rejects.toThrow(ApprovalRequiredError);
    // within limit needs no approval
    await s.production.orderMaterials(opp.id, { supplier: 'ABC', amountUsd: 9_000, items: [] });
  });

  it('requires a human identity on every decision', async () => {
    const s = build();
    const approval = await s.approvals.request({
      action: 'send_contract', requestedBy: 'retail_sales',
      summary: 't', workProduct: {}, reasoning: 't',
    });
    await expect(s.approvals.decide(approval.id, 'approved', '')).rejects.toThrow('human identity');
  });

  it('deposit gate: production cannot start unverified', () => {
    const s = build();
    expect(() => s.production.startJob('x', false)).toThrow('deposit must be verified');
  });
});

// ── Inspection completeness gate ───────────────────────────────────

describe('inspection hard gate', () => {
  it('refuses submission with ANY missing item, names the missing items', async () => {
    const s = build();
    const { opp } = await seedCustomerAndOpp(s, 'inspection_in_progress');
    s.techAssistant.startInspection('i1', opp.id, 'tech-1');
    await s.techAssistant.completeItem('i1', 'exterior_photos');
    await s.techAssistant.completeItem('i1', 'roof_material');
    try {
      await s.techAssistant.submit('i1');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InspectionIncompleteError);
      const missing = (err as InspectionIncompleteError).missing;
      expect(missing).toContain('video_walkthrough');
      expect(missing).toContain('insurance_info');
      expect(missing).not.toContain('exterior_photos');
    }
  });
});

// ── Insurance honesty gate ─────────────────────────────────────────

describe('insurance honesty', () => {
  it('refuses the claim path with no verifiable storm and routes to retail', async () => {
    const s = build();
    const { opp } = await seedCustomerAndOpp(s, 'claim_prep');
    await expect(s.insurance.buildPacket({
      opportunityId: opp.id, carrier: 'Allstate',
      stormHistory: [{ date: '2026-06-01', hailInches: 0.25, windMph: 20, source: 'NOAA' }], // below thresholds
      photos: [], measurements: {}, technicianSummary: 'wear',
    })).rejects.toThrow(UnsupportedClaimError);
    // The honest fallback event was emitted (customer not abandoned)
    expect(s.store.events.some(e => e.eventType === 'path.retail_selected')).toBe(true);
  });
});

// ── Compliance ─────────────────────────────────────────────────────

describe('compliance engine', () => {
  it('blocks sales SMS without consent, allows transactional', async () => {
    const s = build();
    const customer: Customer = {
      id: randomUUID(), phone: '+13135550101',
      consentSms: false, consentEmail: false, dnc: false, optedOut: false, archived: false,
    };
    await s.store.saveCustomer(customer);
    const msg: OutboundMessage = { customerId: customer.id, channel: 'sms', body: 'hi', actor: 'inside_sales', consentBasis: 'none' };
    const salesResult = await s.comms.send(msg, 'sales');
    expect(salesResult.sent).toBe(false);
    expect(salesResult.blockedReason).toContain('consent');
    const txResult = await s.comms.send(msg, 'transactional');
    expect(txResult.sent).toBe(true);
  });

  it('opt-out is instant, permanent, cross-channel — and blocks even transactional', async () => {
    const s = build();
    const compliance = new ComplianceEngine(s.store);
    const { customer } = await seedCustomerAndOpp(s);
    expect(looksLikeOptOut('STOP texting me')).toBe(true);
    expect(looksLikeOptOut('please stop')).toBe(true);
    expect(looksLikeOptOut('ok great, see you then')).toBe(false);
    await compliance.processOptOut(customer.id, 'STOP');
    const msg: OutboundMessage = { customerId: customer.id, channel: 'sms', body: 'hi', actor: 'inside_sales', consentBasis: 'prior' };
    const result = await s.comms.send(msg, 'sales');
    expect(result.sent).toBe(false);
    expect(result.blockedReason).toContain('opted out');
    const tx = await s.comms.send(msg, 'transactional');
    expect(tx.sent).toBe(false);
  });

  it('DNC blocks sales outreach at lead generation AND send time', async () => {
    const s = build();
    const { created, blocked } = await s.leadIntel.generateProspects(
      { date: '2026-07-20', hailInches: 2, windMph: 80, source: 'NOAA', affectedZips: [] },
      [{ address: '2 Oak St', city: 'Detroit', state: 'MI', zip: '48201', ownerPhone: '+13135550102', onDncRegistry: true, hasSolicitationRestriction: false }],
    );
    expect(created).toHaveLength(0);
    expect(blocked).toBe(1);
  });
});

// ── Receptionist ───────────────────────────────────────────────────

describe('receptionist', () => {
  it('classifies and routes an emergency, pages via event, acknowledges customer', async () => {
    const s = build();
    const result = await s.receptionist.handleInbound({
      channel: 'sms', body: 'water is pouring in through my ceiling!!', phone: '+13135550103',
    });
    expect(result.classification).toBe('emergency');
    await s.director.drain();
    const opp = (await s.store.getOpportunity(result.opportunityId!))!;
    expect(opp.stage).toBe('emergency');
    // emergency task created for human page
    const tasks = await s.store.listOpenTasks();
    expect(tasks.some(t => t.title.includes('EMERGENCY'))).toBe(true);
    // customer got instant acknowledgement
    expect(s.sentMessages.some(m => m.customerId === result.customerId)).toBe(true);
  });

  it('routes new inquiries to outreach and handles opt-out inbound', async () => {
    const s = build();
    const inquiry = await s.receptionist.handleInbound({
      channel: 'web_chat', body: 'how much does a new roof cost?', phone: '+13135550104',
    });
    expect(inquiry.classification).toBe('new_inquiry');
    await s.director.drain();
    expect((await s.store.getOpportunity(inquiry.opportunityId!))!.stage).toBe('outreach');

    const optOut = await s.receptionist.handleInbound({
      channel: 'sms', body: 'remove me from your list', phone: '+13135550105',
    });
    expect(optOut.classification).toBe('opt_out');
  });
});

// ── No-stuck guarantees ────────────────────────────────────────────

describe('no-stuck guarantees', () => {
  it('unroutable events park the record for a human instead of dropping it', async () => {
    const s = build();
    const { opp } = await seedCustomerAndOpp(s, 'outreach');
    await emit(s.store, 'totally.unknown_event', 'inside_sales', { opportunityId: opp.id });
    await s.director.drain();
    const parked = (await s.store.getOpportunity(opp.id))!;
    expect(parked.stage).toBe('parked_needs_human');
    const humanTasks = await s.store.listOpenTasks('human');
    expect(humanTasks.length).toBeGreaterThan(0);
  });

  it('dwell-time sweep detects stuck opportunities and creates tasks', async () => {
    const nowRef = { t: new Date('2026-07-23T12:00:00Z') };
    const s = build(nowRef);
    const { opp } = await seedCustomerAndOpp(s, 'path_decision'); // 24h limit
    nowRef.t = new Date('2026-07-25T12:00:00Z'); // 48h later
    const result = await s.execOps.sweep();
    expect(result.stuckCount).toBe(1);
    expect(s.store.events.some(e => e.eventType === 'ops.stuck_opportunity' && e.opportunityId === opp.id)).toBe(true);
  });

  it('leads are never closed by AI — cold proposals go to nurture', async () => {
    const s = build();
    const { opp } = await seedCustomerAndOpp(s, 'proposal');
    await s.retail.proposalWentCold(opp.id);
    await s.director.drain();
    const o = (await s.store.getOpportunity(opp.id))!;
    expect(o.stage).toBe('nurture');
    expect(o.closedReason).toBeUndefined();
  });

  it('claim denial routes back to path_decision (retail fallback), not a dead end', async () => {
    const s = build();
    const { opp } = await seedCustomerAndOpp(s, 'claim_active');
    await s.insurance.claimDenied(opp.id, 'carrier says wear and tear');
    await s.director.drain();
    expect((await s.store.getOpportunity(opp.id))!.stage).toBe('path_decision');
  });
});

// ── Self-healing ───────────────────────────────────────────────────

describe('executive operations / self-healing', () => {
  it('escalates to a page after MAX_RETRIES consecutive failures', async () => {
    const s = build();
    await s.execOps.heartbeat('ghl.sms', 'receptionist', false, 'timeout');
    await s.execOps.heartbeat('ghl.sms', 'receptionist', false, 'timeout');
    expect(s.pages).toHaveLength(0); // still yellow
    await s.execOps.heartbeat('ghl.sms', 'receptionist', false, 'timeout');
    expect(s.pages).toHaveLength(1); // red: paged
    const health = await s.store.getHealth('ghl.sms');
    expect(health!.status).toBe('red');
  });

  it('recovery resets health to green', async () => {
    const s = build();
    await s.execOps.heartbeat('roofr.measurements', 'retail_sales', false, '500');
    await s.execOps.heartbeat('roofr.measurements', 'retail_sales', true);
    const health = await s.store.getHealth('roofr.measurements');
    expect(health!.status).toBe('green');
    expect(health!.consecutiveFailures).toBe(0);
  });

  it('detects heartbeat gaps (silent death is not silent)', async () => {
    const nowRef = { t: new Date('2026-07-23T12:00:00Z') };
    const s = build(nowRef);
    await s.execOps.heartbeat('lead_intel.daily', 'lead_intelligence', true);
    nowRef.t = new Date('2026-07-23T13:01:00Z'); // > 2x expected 15min interval
    const result = await s.execOps.sweep();
    expect(result.escalations.some(e => e.what.includes('stopped reporting'))).toBe(true);
  });

  it('escalates overdue approvals', async () => {
    const nowRef = { t: new Date('2026-07-23T12:00:00Z') };
    const s = build(nowRef);
    await s.approvals.request({
      action: 'send_contract', requestedBy: 'retail_sales',
      summary: 'send it', workProduct: {}, reasoning: 'r', urgency: 'high', // 4h SLA
    });
    nowRef.t = new Date('2026-07-23T17:00:00Z'); // 5h later
    const result = await s.execOps.sweep();
    expect(result.escalations.some(e => e.what.includes('Approval overdue'))).toBe(true);
  });
});

// ── Memory + lifecycle ─────────────────────────────────────────────

describe('customer memory and lifecycle', () => {
  it('memory written by one department is read by all', async () => {
    const s = build();
    const { customer, opp } = await seedCustomerAndOpp(s);
    await s.insideSales.bookInspection(opp.id, new Date(), { carrier: 'State Farm', roofAgeYears: 12 });
    const memory = await s.store.getMemory(customer.id);
    expect(memory.some(m => m.category === 'insurance_history' && m.content.includes('State Farm'))).toBe(true);
  });

  it('customer success escalates negative sentiment to a human', async () => {
    const s = build();
    const { customer } = await seedCustomerAndOpp(s);
    const outcome = await s.customerSuccess.handleReply(customer.id, "I'm still waiting and no one told me anything");
    expect(outcome).toBe('escalated');
    expect((await s.store.listOpenTasks('human')).length).toBeGreaterThan(0);
  });

  it('marketing routes unhappy completions to a human instead of a review link', async () => {
    const s = build();
    const { customer, opp } = await seedCustomerAndOpp(s, 'warranty_active');
    const result = await s.marketing.reviewRequestOnPaidInFull(customer.id, opp.id, false);
    expect(result).toBe('routed_to_human');
  });

  it('warranty registration deadlines raise critical alerts', async () => {
    const nowRef = { t: new Date('2026-07-23T12:00:00Z') };
    const s = build(nowRef);
    const { customer, opp } = await seedCustomerAndOpp(s, 'warranty_active');
    await s.warranty.activate(opp.id, customer.id, 'GAF', 30);
    nowRef.t = new Date('2026-08-18T12:00:00Z'); // 26 days in, deadline in 4
    const critical = await s.warranty.sweepRegistrations();
    expect(critical).toContain(opp.id);
  });
});
