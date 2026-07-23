// ── In-memory Store implementation (tests + local dev) ─────────────

import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type {
  Approval, AuditEntry, BusEvent, Customer, Decision, HealthRecord,
  MemoryEntry, Opportunity, WorkTask,
} from './types.js';

export class MemoryStore implements Store {
  opportunities = new Map<string, Opportunity>();
  customers = new Map<string, Customer>();
  events: BusEvent[] = [];
  tasks = new Map<string, WorkTask>();
  approvals = new Map<string, Approval>();
  decisions: (Decision & { createdAt: Date })[] = [];
  audit: AuditEntry[] = [];
  memory: MemoryEntry[] = [];
  health = new Map<string, HealthRecord>();
  private eventSeq = 0;

  async getOpportunity(id: string) { return this.opportunities.get(id); }
  async saveOpportunity(o: Opportunity) { this.opportunities.set(o.id, { ...o }); }
  async listOpportunitiesByStage(stage: Opportunity['stage']) {
    return [...this.opportunities.values()].filter(o => o.stage === stage);
  }
  async listAllOpportunities() { return [...this.opportunities.values()]; }

  async getCustomer(id: string) { return this.customers.get(id); }
  async saveCustomer(c: Customer) { this.customers.set(c.id, { ...c }); }
  async findCustomerByContact(phone?: string, email?: string) {
    return [...this.customers.values()].find(c =>
      (phone && c.phone === phone) || (email && c.email === email));
  }

  async appendEvent(e: Omit<BusEvent, 'id' | 'createdAt'>) {
    const ev: BusEvent = { ...e, id: ++this.eventSeq, createdAt: new Date() };
    this.events.push(ev);
    return ev;
  }
  async nextUnprocessedEvent() {
    return this.events.find(e => !e.processedAt);
  }
  async markEventProcessed(id: number, error?: string) {
    const e = this.events.find(ev => ev.id === id);
    if (e) { e.processedAt = new Date(); if (error) e.processingError = error; }
  }

  async createTask(t: Omit<WorkTask, 'id' | 'createdAt' | 'status'>) {
    const task: WorkTask = { ...t, id: randomUUID(), status: 'open', createdAt: new Date() };
    this.tasks.set(task.id, task);
    return task;
  }
  async updateTask(id: string, patch: Partial<WorkTask>) {
    const t = this.tasks.get(id);
    if (t) this.tasks.set(id, { ...t, ...patch });
  }
  async listOpenTasks(owner?: WorkTask['owner']) {
    return [...this.tasks.values()].filter(t =>
      (t.status === 'open' || t.status === 'in_progress') && (!owner || t.owner === owner));
  }

  async createApproval(a: Omit<Approval, 'id' | 'createdAt' | 'status'>) {
    const approval: Approval = { ...a, id: randomUUID(), status: 'pending', createdAt: new Date() };
    this.approvals.set(approval.id, approval);
    return approval;
  }
  async getApproval(id: string) { return this.approvals.get(id); }
  async decideApproval(id: string, status: 'approved' | 'denied', decidedBy: string, note?: string) {
    const a = this.approvals.get(id);
    if (!a) throw new Error(`approval ${id} not found`);
    if (!decidedBy) throw new Error('APPROVAL_GATE: decisions require a human identity');
    const decided: Approval = { ...a, status, decidedBy, decidedAt: new Date(), decisionNote: note };
    this.approvals.set(id, decided);
    return decided;
  }
  async listPendingApprovals() {
    return [...this.approvals.values()].filter(a => a.status === 'pending');
  }

  async recordDecision(d: Decision) { this.decisions.push({ ...d, createdAt: new Date() }); }
  async appendAudit(a: Omit<AuditEntry, 'createdAt'>) { this.audit.push({ ...a, createdAt: new Date() }); }
  async listAudit() { return [...this.audit]; }

  async appendMemory(m: Omit<MemoryEntry, 'createdAt'>) { this.memory.push({ ...m, createdAt: new Date() }); }
  async getMemory(customerId: string) {
    return this.memory.filter(m => m.customerId === customerId && !m.deleted);
  }

  async upsertHealth(h: HealthRecord) { this.health.set(h.automationKey, { ...h }); }
  async getHealth(key: string) { return this.health.get(key); }
  async listHealth() { return [...this.health.values()]; }
}
