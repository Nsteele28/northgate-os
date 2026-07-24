// ── Supabase Store adapter ─────────────────────────────────────────
// Implements the Store interface against the live Supabase project
// via PostgREST. The database's own triggers enforce the hard gates
// a second time — defense in depth.

import type { Store } from '../core/store.js';
import type {
  Approval, AuditEntry, BusEvent, Customer, Decision, HealthRecord,
  MemoryEntry, Opportunity, WorkTask,
} from '../core/types.js';

interface Config { url: string; serviceKey: string }

export class SupabaseStore implements Store {
  constructor(private cfg: Config) {}

  /** Public read helper for the KPI engine (read-only queries). */
  async query(path: string): Promise<Record<string, unknown>[]> {
    return (await this.rest(path)) as Record<string, unknown>[];
  }

  private async rest(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${this.cfg.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.cfg.serviceKey,
        Authorization: `Bearer ${this.cfg.serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...init.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`supabase ${init.method ?? 'GET'} ${path}: ${res.status} ${(await res.text()).slice(0, 400)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ── opportunities ────────────────────────────────────────────────

  private oppFromRow(r: Record<string, unknown>): Opportunity {
    return {
      id: r.id as string,
      customerId: r.customer_id as string,
      propertyId: (r.property_id as string) ?? undefined,
      stage: r.stage as Opportunity['stage'],
      stageEnteredAt: new Date(r.stage_entered_at as string),
      owningDepartment: r.owning_department as Opportunity['owningDepartment'],
      path: (r.path as Opportunity['path']) ?? 'undecided',
      source: (r.source as string) ?? undefined,
      score: (r.score as number) ?? undefined,
      estimatedValue: (r.estimated_value as number) ?? undefined,
      nextAction: (r.next_action as string) ?? undefined,
      nextActionDue: r.next_action_due ? new Date(r.next_action_due as string) : undefined,
      closedReason: (r.closed_reason as string) ?? undefined,
      closedBy: (r.closed_by as string) ?? undefined,
    };
  }

  private oppToRow(o: Opportunity): Record<string, unknown> {
    return {
      id: o.id,
      customer_id: o.customerId,
      property_id: o.propertyId ?? null,
      stage: o.stage,
      stage_entered_at: o.stageEnteredAt.toISOString(),
      owning_department: o.owningDepartment,
      path: o.path,
      source: o.source ?? null,
      score: o.score ?? null,
      estimated_value: o.estimatedValue ?? null,
      next_action: o.nextAction ?? null,
      next_action_due: o.nextActionDue?.toISOString() ?? null,
      closed_reason: o.closedReason ?? null,
      closed_by: o.closedBy ?? null,
    };
  }

  async getOpportunity(id: string) {
    const rows = await this.rest(`opportunities?id=eq.${id}&limit=1`) as Record<string, unknown>[];
    return rows[0] ? this.oppFromRow(rows[0]) : undefined;
  }
  async saveOpportunity(o: Opportunity) {
    await this.rest('opportunities?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(this.oppToRow(o)),
    });
  }
  async listOpportunitiesByStage(stage: Opportunity['stage']) {
    const rows = await this.rest(`opportunities?stage=eq.${stage}&closed_reason=is.null`) as Record<string, unknown>[];
    return rows.map(r => this.oppFromRow(r));
  }
  async listAllOpportunities() {
    const rows = await this.rest('opportunities?closed_reason=is.null&limit=10000') as Record<string, unknown>[];
    return rows.map(r => this.oppFromRow(r));
  }

  // ── customers ────────────────────────────────────────────────────

  private custFromRow(r: Record<string, unknown>): Customer {
    return {
      id: r.id as string,
      firstName: (r.first_name as string) ?? undefined,
      lastName: (r.last_name as string) ?? undefined,
      phone: (r.phone_normalized as string) ?? undefined,
      email: (r.email_normalized as string) ?? undefined,
      preferredChannel: (r.preferred_channel as Customer['preferredChannel']) ?? undefined,
      consentSms: !!r.consent_sms,
      consentEmail: !!r.consent_email,
      dnc: !!r.dnc,
      optedOut: !!r.opted_out,
      optedOutAt: r.opted_out_at ? new Date(r.opted_out_at as string) : undefined,
      archived: !!r.archived,
    };
  }

  async getCustomer(id: string) {
    const rows = await this.rest(`customers?id=eq.${id}&limit=1`) as Record<string, unknown>[];
    return rows[0] ? this.custFromRow(rows[0]) : undefined;
  }
  async saveCustomer(c: Customer) {
    await this.rest('customers?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        id: c.id,
        first_name: c.firstName ?? null,
        last_name: c.lastName ?? null,
        phone_normalized: c.phone ?? null,
        email_normalized: c.email ?? null,
        preferred_channel: c.preferredChannel ?? null,
        consent_sms: c.consentSms,
        consent_email: c.consentEmail,
        dnc: c.dnc,
        opted_out: c.optedOut,
        opted_out_at: c.optedOutAt?.toISOString() ?? null,
        archived: c.archived,
      }),
    });
  }
  async findCustomerByContact(phone?: string, email?: string) {
    const filters: string[] = [];
    if (phone) filters.push(`phone_normalized.eq.${encodeURIComponent(phone)}`);
    if (email) filters.push(`email_normalized.eq.${encodeURIComponent(email.toLowerCase())}`);
    if (!filters.length) return undefined;
    const rows = await this.rest(`customers?or=(${filters.join(',')})&limit=1`) as Record<string, unknown>[];
    return rows[0] ? this.custFromRow(rows[0]) : undefined;
  }

  // ── events ───────────────────────────────────────────────────────

  private eventFromRow(r: Record<string, unknown>): BusEvent {
    return {
      id: r.id as number,
      eventType: r.event_type as string,
      opportunityId: (r.opportunity_id as string) ?? undefined,
      customerId: (r.customer_id as string) ?? undefined,
      actor: r.actor as BusEvent['actor'],
      payload: (r.payload as Record<string, unknown>) ?? {},
      processedAt: r.processed_at ? new Date(r.processed_at as string) : undefined,
      processingError: (r.processing_error as string) ?? undefined,
      createdAt: new Date(r.created_at as string),
    };
  }

  async appendEvent(e: Omit<BusEvent, 'id' | 'createdAt'>) {
    const rows = await this.rest('events', {
      method: 'POST',
      body: JSON.stringify({
        event_type: e.eventType,
        opportunity_id: e.opportunityId ?? null,
        customer_id: e.customerId ?? null,
        actor: e.actor,
        payload: e.payload,
      }),
    }) as Record<string, unknown>[];
    return this.eventFromRow(rows[0]!);
  }
  async nextUnprocessedEvent() {
    const rows = await this.rest('events?processed_at=is.null&order=id.asc&limit=1') as Record<string, unknown>[];
    return rows[0] ? this.eventFromRow(rows[0]) : undefined;
  }
  async markEventProcessed(id: number, error?: string) {
    await this.rest(`events?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ processed_at: new Date().toISOString(), processing_error: error ?? null }),
    });
  }

  // ── tasks ────────────────────────────────────────────────────────

  private taskFromRow(r: Record<string, unknown>): WorkTask {
    return {
      id: r.id as string,
      opportunityId: (r.opportunity_id as string) ?? undefined,
      owner: r.owner as WorkTask['owner'],
      title: r.title as string,
      detail: (r.detail as Record<string, unknown>) ?? {},
      status: r.status as WorkTask['status'],
      dueAt: r.due_at ? new Date(r.due_at as string) : undefined,
      escalateAfter: r.escalate_after ? new Date(r.escalate_after as string) : undefined,
      createdBy: r.created_by as WorkTask['createdBy'],
      createdAt: new Date(r.created_at as string),
    };
  }

  async createTask(t: Omit<WorkTask, 'id' | 'createdAt' | 'status'>) {
    const rows = await this.rest('tasks', {
      method: 'POST',
      body: JSON.stringify({
        opportunity_id: t.opportunityId ?? null,
        owner: t.owner,
        title: t.title,
        detail: t.detail,
        due_at: t.dueAt?.toISOString() ?? null,
        escalate_after: t.escalateAfter?.toISOString() ?? null,
        created_by: t.createdBy,
      }),
    }) as Record<string, unknown>[];
    return this.taskFromRow(rows[0]!);
  }
  async updateTask(id: string, patch: Partial<WorkTask>) {
    const row: Record<string, unknown> = {};
    if (patch.status) row.status = patch.status;
    if (patch.title) row.title = patch.title;
    if (patch.detail) row.detail = patch.detail;
    await this.rest(`tasks?id=eq.${id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row),
    });
  }
  async listOpenTasks(owner?: WorkTask['owner']) {
    const ownerFilter = owner ? `&owner=eq.${owner}` : '';
    const rows = await this.rest(`tasks?status=in.(open,in_progress)${ownerFilter}&order=created_at.asc`) as Record<string, unknown>[];
    return rows.map(r => this.taskFromRow(r));
  }

  // ── approvals ────────────────────────────────────────────────────

  private approvalFromRow(r: Record<string, unknown>): Approval {
    return {
      id: r.id as string,
      action: r.action as Approval['action'],
      opportunityId: (r.opportunity_id as string) ?? undefined,
      requestedBy: r.requested_by as Approval['requestedBy'],
      summary: r.summary as string,
      workProduct: (r.work_product as Record<string, unknown>) ?? {},
      reasoning: r.reasoning as string,
      consequences: (r.consequences as string) ?? undefined,
      urgency: r.urgency as Approval['urgency'],
      slaDue: r.sla_due ? new Date(r.sla_due as string) : undefined,
      status: r.status as Approval['status'],
      decidedBy: (r.decided_by as string) ?? undefined,
      decidedAt: r.decided_at ? new Date(r.decided_at as string) : undefined,
      decisionNote: (r.decision_note as string) ?? undefined,
      createdAt: new Date(r.created_at as string),
    };
  }

  async createApproval(a: Omit<Approval, 'id' | 'createdAt' | 'status'>) {
    const rows = await this.rest('approvals', {
      method: 'POST',
      body: JSON.stringify({
        action: a.action,
        opportunity_id: a.opportunityId ?? null,
        requested_by: a.requestedBy,
        summary: a.summary,
        work_product: a.workProduct,
        reasoning: a.reasoning,
        consequences: a.consequences ?? null,
        urgency: a.urgency,
        sla_due: a.slaDue?.toISOString() ?? null,
      }),
    }) as Record<string, unknown>[];
    return this.approvalFromRow(rows[0]!);
  }
  async getApproval(id: string) {
    const rows = await this.rest(`approvals?id=eq.${id}&limit=1`) as Record<string, unknown>[];
    return rows[0] ? this.approvalFromRow(rows[0]) : undefined;
  }
  async decideApproval(id: string, status: 'approved' | 'denied', decidedBy: string, note?: string) {
    const rows = await this.rest(`approvals?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status, decided_by: decidedBy, decided_at: new Date().toISOString(), decision_note: note ?? null,
      }),
    }) as Record<string, unknown>[];
    if (!rows[0]) throw new Error(`approval ${id} not found`);
    return this.approvalFromRow(rows[0]);
  }
  async listPendingApprovals() {
    const rows = await this.rest('approvals?status=eq.pending&order=created_at.asc') as Record<string, unknown>[];
    return rows.map(r => this.approvalFromRow(r));
  }

  // ── decisions + audit ────────────────────────────────────────────

  async recordDecision(d: Decision) {
    await this.rest('decisions', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        actor: d.actor, opportunity_id: d.opportunityId ?? null,
        decision: d.decision, inputs: d.inputs, reasoning: d.reasoning,
      }),
    });
  }
  async appendAudit(a: Omit<AuditEntry, 'createdAt'>) {
    await this.rest('audit_log', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        actor: a.actor, action: a.action,
        entity_table: a.entityTable ?? null, entity_id: a.entityId ?? null,
        before: a.before ?? null, after: a.after ?? null,
      }),
    });
  }
  async listAudit() {
    const rows = await this.rest('audit_log?order=id.desc&limit=1000') as Record<string, unknown>[];
    return rows.map(r => ({
      actor: r.actor as string,
      action: r.action as string,
      entityTable: (r.entity_table as string) ?? undefined,
      entityId: (r.entity_id as string) ?? undefined,
      before: r.before,
      after: r.after,
      createdAt: new Date(r.created_at as string),
    }));
  }

  // ── memory ───────────────────────────────────────────────────────

  async appendMemory(m: Omit<MemoryEntry, 'createdAt'>) {
    await this.rest('customer_memory', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        customer_id: m.customerId, category: m.category, content: m.content,
        source: m.source, source_ref: m.sourceRef ?? null,
      }),
    });
  }
  async getMemory(customerId: string) {
    const rows = await this.rest(`customer_memory?customer_id=eq.${customerId}&deleted=eq.false&order=created_at.asc`) as Record<string, unknown>[];
    return rows.map(r => ({
      customerId: r.customer_id as string,
      category: r.category as MemoryEntry['category'],
      content: r.content as string,
      source: r.source as MemoryEntry['source'],
      sourceRef: (r.source_ref as string) ?? undefined,
      createdAt: new Date(r.created_at as string),
    }));
  }

  // ── health ───────────────────────────────────────────────────────

  async upsertHealth(h: HealthRecord) {
    await this.rest('automation_health?on_conflict=automation_key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        automation_key: h.automationKey,
        department: h.department,
        status: h.status,
        last_heartbeat: h.lastHeartbeat?.toISOString() ?? null,
        last_success: h.lastSuccess?.toISOString() ?? null,
        consecutive_failures: h.consecutiveFailures,
        last_error: h.lastError ?? null,
        heartbeat_expected_every: `${Math.round(h.heartbeatExpectedEveryMs / 1000)} seconds`,
      }),
    });
  }
  async getHealth(key: string) {
    const rows = await this.rest(`automation_health?automation_key=eq.${key}&limit=1`) as Record<string, unknown>[];
    return rows[0] ? this.healthFromRow(rows[0]) : undefined;
  }
  async listHealth() {
    const rows = await this.rest('automation_health') as Record<string, unknown>[];
    return rows.map(r => this.healthFromRow(r));
  }
  private healthFromRow(r: Record<string, unknown>): HealthRecord {
    return {
      automationKey: r.automation_key as string,
      department: r.department as HealthRecord['department'],
      status: r.status as HealthRecord['status'],
      lastHeartbeat: r.last_heartbeat ? new Date(r.last_heartbeat as string) : undefined,
      lastSuccess: r.last_success ? new Date(r.last_success as string) : undefined,
      consecutiveFailures: (r.consecutive_failures as number) ?? 0,
      lastError: (r.last_error as string) ?? undefined,
      heartbeatExpectedEveryMs: 15 * 60_000,
    };
  }
}
