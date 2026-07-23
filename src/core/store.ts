// ── Storage abstraction ────────────────────────────────────────────
// The engine talks to this interface. Production uses the Supabase
// adapter; tests use the in-memory store. Behavior is identical —
// including the hard gates, which the Supabase schema ALSO enforces
// at the database layer as defense in depth.

import type {
  Approval, AuditEntry, BusEvent, Customer, Decision, HealthRecord,
  MemoryEntry, Opportunity, WorkTask,
} from './types.js';

export interface Store {
  // opportunities
  getOpportunity(id: string): Promise<Opportunity | undefined>;
  saveOpportunity(o: Opportunity): Promise<void>;
  listOpportunitiesByStage(stage: Opportunity['stage']): Promise<Opportunity[]>;
  listAllOpportunities(): Promise<Opportunity[]>;

  // customers
  getCustomer(id: string): Promise<Customer | undefined>;
  saveCustomer(c: Customer): Promise<void>;
  findCustomerByContact(phone?: string, email?: string): Promise<Customer | undefined>;

  // events (append-only)
  appendEvent(e: Omit<BusEvent, 'id' | 'createdAt'>): Promise<BusEvent>;
  nextUnprocessedEvent(): Promise<BusEvent | undefined>;
  markEventProcessed(id: number, error?: string): Promise<void>;

  // tasks
  createTask(t: Omit<WorkTask, 'id' | 'createdAt' | 'status'>): Promise<WorkTask>;
  updateTask(id: string, patch: Partial<WorkTask>): Promise<void>;
  listOpenTasks(owner?: WorkTask['owner']): Promise<WorkTask[]>;

  // approvals
  createApproval(a: Omit<Approval, 'id' | 'createdAt' | 'status'>): Promise<Approval>;
  getApproval(id: string): Promise<Approval | undefined>;
  decideApproval(id: string, status: 'approved' | 'denied', decidedBy: string, note?: string): Promise<Approval>;
  listPendingApprovals(): Promise<Approval[]>;

  // decisions + audit (append-only)
  recordDecision(d: Decision): Promise<void>;
  appendAudit(a: Omit<AuditEntry, 'createdAt'>): Promise<void>;
  listAudit(): Promise<AuditEntry[]>;

  // memory
  appendMemory(m: Omit<MemoryEntry, 'createdAt'>): Promise<void>;
  getMemory(customerId: string): Promise<MemoryEntry[]>;

  // health
  upsertHealth(h: HealthRecord): Promise<void>;
  getHealth(automationKey: string): Promise<HealthRecord | undefined>;
  listHealth(): Promise<HealthRecord[]>;
}
