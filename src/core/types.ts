// ── Core domain types for the Northgate AI Operating System ────────

export type JourneyStage =
  | 'new_lead' | 'inbound_contact' | 'outreach' | 'inspection_scheduled'
  | 'inspection_in_progress' | 'path_decision' | 'claim_prep' | 'claim_active'
  | 'proposal' | 'production_queue' | 'installing' | 'invoicing'
  | 'warranty_active' | 'nurture' | 'emergency' | 'parked_needs_human';

export type Department =
  | 'receptionist' | 'lead_intelligence' | 'inside_sales'
  | 'inspection_coordinator' | 'technician_assistant' | 'insurance_coordinator'
  | 'retail_sales' | 'production_manager' | 'collections_manager'
  | 'warranty_department' | 'customer_success' | 'marketing'
  | 'executive_operations' | 'operations_director' | 'human';

export type GatedAction =
  | 'change_pricing' | 'approve_discount' | 'waive_balance'
  | 'send_legal_document' | 'send_contract' | 'submit_insurance_packet'
  | 'file_supplement' | 'order_materials_above_limit' | 'cancel_contract'
  | 'merge_customer_records' | 'override_compliance' | 'publish_public_content'
  | 'initiate_legal_collection';

export type Channel =
  | 'call' | 'sms' | 'email' | 'web_chat' | 'fb_messenger'
  | 'gbp_message' | 'voicemail' | 'in_person';

export interface Opportunity {
  id: string;
  customerId: string;
  propertyId?: string;
  stage: JourneyStage;
  stageEnteredAt: Date;
  owningDepartment: Department;
  path: 'insurance' | 'retail' | 'undecided';
  source?: string;
  score?: number;
  estimatedValue?: number;
  nextAction?: string;
  nextActionDue?: Date;
  closedReason?: string;
  closedBy?: string;
}

export interface Customer {
  id: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  preferredChannel?: Channel;
  consentSms: boolean;
  consentEmail: boolean;
  dnc: boolean;
  optedOut: boolean;
  optedOutAt?: Date;
  archived: boolean;
}

export interface BusEvent {
  id?: number;
  eventType: string;
  opportunityId?: string;
  customerId?: string;
  actor: Department;
  payload: Record<string, unknown>;
  processedAt?: Date;
  processingError?: string;
  createdAt: Date;
}

export interface Approval {
  id: string;
  action: GatedAction;
  opportunityId?: string;
  requestedBy: Department;
  summary: string;
  workProduct: Record<string, unknown>;
  reasoning: string;
  consequences?: string;
  urgency: 'low' | 'normal' | 'high' | 'critical';
  slaDue?: Date;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decidedBy?: string;
  decidedAt?: Date;
  decisionNote?: string;
  createdAt: Date;
}

export interface WorkTask {
  id: string;
  opportunityId?: string;
  owner: Department;
  title: string;
  detail: Record<string, unknown>;
  status: 'open' | 'in_progress' | 'done' | 'escalated' | 'cancelled';
  dueAt?: Date;
  escalateAfter?: Date;
  createdBy: Department;
  createdAt: Date;
}

export interface Decision {
  actor: Department;
  opportunityId?: string;
  decision: string;
  inputs: Record<string, unknown>;
  reasoning: string;
}

export interface HealthRecord {
  automationKey: string;
  department: Department;
  status: 'green' | 'yellow' | 'red';
  lastHeartbeat?: Date;
  lastSuccess?: Date;
  consecutiveFailures: number;
  lastError?: string;
  heartbeatExpectedEveryMs: number;
}

export interface AuditEntry {
  actor: string;
  action: string;
  entityTable?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  createdAt: Date;
}

export interface MemoryEntry {
  customerId: string;
  category:
    | 'conversation_summary' | 'roof_history' | 'insurance_history'
    | 'repair_history' | 'personal_note' | 'communication_preference'
    | 'scheduling_preference' | 'referral' | 'warranty'
    | 'past_estimate' | 'past_objection';
  content: string;
  source: Department;
  sourceRef?: string;
  deleted?: boolean;
  createdAt: Date;
}

export interface OutboundMessage {
  customerId: string;
  opportunityId?: string;
  channel: Channel;
  body: string;
  actor: Department;
  consentBasis: string;
}
