-- ═══════════════════════════════════════════════════════════════════
-- Northgate Construction AI Operating System — Core Schema
-- Migration 001: canonical data layer
-- Supabase is the single source of truth; GHL and Roofr are mirrored.
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists "uuid-ossp";
create extension if not exists pg_trgm; -- fuzzy duplicate matching

-- ── Enumerations ───────────────────────────────────────────────────

create type journey_stage as enum (
  'new_lead', 'inbound_contact', 'outreach', 'inspection_scheduled',
  'inspection_in_progress', 'path_decision', 'claim_prep', 'claim_active',
  'proposal', 'production_queue', 'installing', 'invoicing',
  'warranty_active', 'nurture', 'emergency', 'parked_needs_human'
);

create type department as enum (
  'receptionist', 'lead_intelligence', 'inside_sales',
  'inspection_coordinator', 'technician_assistant', 'insurance_coordinator',
  'retail_sales', 'production_manager', 'collections_manager',
  'warranty_department', 'customer_success', 'marketing',
  'executive_operations', 'operations_director', 'human'
);

create type approval_status as enum ('pending', 'approved', 'denied', 'expired');

create type gated_action as enum (
  'change_pricing', 'approve_discount', 'waive_balance',
  'send_legal_document', 'send_contract', 'submit_insurance_packet',
  'file_supplement', 'order_materials_above_limit', 'cancel_contract',
  'merge_customer_records', 'override_compliance', 'publish_public_content',
  'initiate_legal_collection'
);

create type task_status as enum ('open', 'in_progress', 'done', 'escalated', 'cancelled');
create type health_status as enum ('green', 'yellow', 'red');
create type comm_channel as enum ('call', 'sms', 'email', 'web_chat', 'fb_messenger', 'gbp_message', 'voicemail', 'in_person');

-- ── Customers ──────────────────────────────────────────────────────

create table customers (
  id uuid primary key default uuid_generate_v4(),
  first_name text,
  last_name text,
  phone_normalized text,          -- E.164
  email_normalized text,          -- lowercased
  ghl_contact_id text unique,
  preferred_channel comm_channel,
  preferred_name text,
  quiet_hours_override jsonb,     -- customer-specific contact-time prefs
  consent_sms boolean not null default false,
  consent_email boolean not null default false,
  consent_source text,            -- where/when consent was captured
  dnc boolean not null default false,        -- federal/state DNC registry
  opted_out boolean not null default false,  -- customer said stop: permanent
  opted_out_at timestamptz,
  archived boolean not null default false,   -- records are never deleted
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_phone_idx on customers (phone_normalized);
create index customers_email_idx on customers (email_normalized);
create index customers_name_trgm on customers using gin ((coalesce(first_name,'') || ' ' || coalesce(last_name,'')) gin_trgm_ops);

-- ── Properties ─────────────────────────────────────────────────────

create table properties (
  id uuid primary key default uuid_generate_v4(),
  address_line1 text not null,
  address_line2 text,
  city text not null,
  state text not null,
  zip text not null,
  address_normalized text not null, -- canonical form for dedupe
  parcel_id text,
  owner_customer_id uuid references customers(id),
  roof_material text,
  roof_age_years int,
  roof_squares numeric,
  roofr_measurement_id text,
  storm_history jsonb not null default '[]', -- [{date, hail_in, wind_mph, source}]
  jurisdiction text,               -- permit jurisdiction key
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (address_normalized)
);
create index properties_owner_idx on properties (owner_customer_id);

-- ── Opportunities: the object that moves through the state machine ─

create table opportunities (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid not null references customers(id),
  property_id uuid references properties(id),
  stage journey_stage not null default 'new_lead',
  stage_entered_at timestamptz not null default now(),
  owning_department department not null default 'lead_intelligence',
  path text check (path in ('insurance', 'retail', 'undecided')) default 'undecided',
  source text,                     -- attribution
  source_campaign text,
  score numeric,                   -- lead intelligence score
  estimated_value numeric,
  ghl_opportunity_id text,
  next_action text,                -- human-readable next step (never null in practice)
  next_action_due timestamptz,
  closed_reason text,              -- only a human may set a permanent close
  closed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index opportunities_stage_idx on opportunities (stage);
create index opportunities_customer_idx on opportunities (customer_id);
create index opportunities_dwell_idx on opportunities (stage, stage_entered_at);

-- ── Conversations: unified thread across every channel ─────────────

create table conversations (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid not null references customers(id),
  opportunity_id uuid references opportunities(id),
  channel comm_channel not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  actor department,                -- which AI/human sent it (outbound)
  body text,
  transcript jsonb,                -- structured call transcript
  external_id text,               -- GHL/Twilio message id
  consent_basis text,             -- why this outbound send was permitted
  delivered boolean,
  delivery_error text,
  sentiment text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index conversations_customer_idx on conversations (customer_id, occurred_at);

-- ── Inspections ────────────────────────────────────────────────────

create table inspections (
  id uuid primary key default uuid_generate_v4(),
  opportunity_id uuid not null references opportunities(id),
  property_id uuid not null references properties(id),
  technician_id uuid,             -- references staff table (008)
  scheduled_at timestamptz,
  gps_arrived_at timestamptz,
  gps_arrival_coords jsonb,
  checklist jsonb not null default '{}',    -- item -> {complete, at, data}
  required_items text[] not null default array[
    'exterior_photos','damage_closeups','slope_photos','gutter_photos',
    'penetration_photos','video_walkthrough','measurement_verification',
    'roof_material','roof_age','damage_documentation','interior_check',
    'insurance_info','customer_notes'
  ],
  photos jsonb not null default '[]',       -- [{url, label, damage_point}]
  videos jsonb not null default '[]',
  damage_summary jsonb,
  quality_score numeric,
  submitted_at timestamptz,       -- only settable when required items complete (trigger)
  synced boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inspections_opportunity_idx on inspections (opportunity_id);

-- Hard gate: an inspection cannot be submitted incomplete.
create or replace function enforce_inspection_completeness() returns trigger as $$
declare missing text[];
begin
  if new.submitted_at is not null and old.submitted_at is null then
    select array_agg(item) into missing
    from unnest(new.required_items) as item
    where coalesce((new.checklist -> item ->> 'complete')::boolean, false) = false;
    if missing is not null then
      raise exception 'INSPECTION_INCOMPLETE: missing %', array_to_string(missing, ', ');
    end if;
  end if;
  return new;
end; $$ language plpgsql;

create trigger inspections_completeness before update on inspections
  for each row execute function enforce_inspection_completeness();

-- ── Claims ─────────────────────────────────────────────────────────

create table claims (
  id uuid primary key default uuid_generate_v4(),
  opportunity_id uuid not null references opportunities(id),
  carrier text not null,
  claim_number text,
  policy_number text,
  adjuster_name text,
  adjuster_contact jsonb,
  status text not null default 'preparing',
  storm_verification jsonb,       -- {verified, event_date, hail_in, wind_mph, sources[]}
  storm_verified boolean not null default false,
  evidence_packet_url text,
  packet_approved_by text,        -- human identity: required before submission
  packet_approved_at timestamptz,
  submitted_at timestamptz,
  timeline jsonb not null default '[]',     -- [{milestone, at, note}]
  expected_next_milestone text,
  expected_next_by timestamptz,
  supplements jsonb not null default '[]',  -- [{scope_item, amount, status, approved_by}]
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hard gates: no submission without verified storm data AND human approval.
create or replace function enforce_claim_gates() returns trigger as $$
begin
  if new.submitted_at is not null and old.submitted_at is null then
    if not new.storm_verified then
      raise exception 'CLAIM_GATE: storm verification required before submission';
    end if;
    if new.packet_approved_by is null then
      raise exception 'CLAIM_GATE: human packet approval required before submission';
    end if;
  end if;
  return new;
end; $$ language plpgsql;

create trigger claims_gates before update on claims
  for each row execute function enforce_claim_gates();

-- ── Contracts, invoices, payments ──────────────────────────────────

create table proposals (
  id uuid primary key default uuid_generate_v4(),
  opportunity_id uuid not null references opportunities(id),
  roofr_estimate_id text,
  options jsonb not null default '[]',   -- good/better/best line items
  list_price numeric not null,
  final_price numeric not null,
  discount_approved_by text,             -- required if final_price < list_price
  financing_presented jsonb,
  delivered_at timestamptz,
  viewed_at timestamptz,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function enforce_pricing_gate() returns trigger as $$
begin
  if new.final_price < new.list_price and new.discount_approved_by is null then
    raise exception 'PRICING_GATE: discount requires human approval';
  end if;
  return new;
end; $$ language plpgsql;

create trigger proposals_pricing before insert or update on proposals
  for each row execute function enforce_pricing_gate();

create table contracts (
  id uuid primary key default uuid_generate_v4(),
  opportunity_id uuid not null references opportunities(id),
  proposal_id uuid references proposals(id),
  document_url text,
  send_approved_by text,          -- human identity: required before send
  sent_at timestamptz,
  signed_at timestamptz,
  esign_envelope_id text,
  cancelled_at timestamptz,
  cancelled_by text,              -- must be human
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function enforce_contract_gates() returns trigger as $$
begin
  if new.sent_at is not null and (old.sent_at is null or old.sent_at is distinct from new.sent_at) then
    if new.send_approved_by is null then
      raise exception 'CONTRACT_GATE: human approval required before sending contract';
    end if;
  end if;
  if new.cancelled_at is not null and old.cancelled_at is null and new.cancelled_by is null then
    raise exception 'CONTRACT_GATE: only a human may cancel a signed contract';
  end if;
  return new;
end; $$ language plpgsql;

create trigger contracts_gates before update on contracts
  for each row execute function enforce_contract_gates();

create table invoices (
  id uuid primary key default uuid_generate_v4(),
  opportunity_id uuid not null references opportunities(id),
  contract_id uuid references contracts(id),
  amount numeric not null,
  balance numeric not null,
  due_date date,
  status text not null default 'open',
  mortgage_company jsonb,         -- endorsement tracking
  insurance_payment_tracking jsonb,
  waived_amount numeric not null default 0,
  waived_by text,                 -- must be human if waived_amount > 0
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function enforce_waiver_gate() returns trigger as $$
begin
  if new.waived_amount > 0 and new.waived_by is null then
    raise exception 'WAIVER_GATE: balance waiver requires human approval';
  end if;
  return new;
end; $$ language plpgsql;

create trigger invoices_waiver before insert or update on invoices
  for each row execute function enforce_waiver_gate();

create table payments (
  id uuid primary key default uuid_generate_v4(),
  invoice_id uuid not null references invoices(id),
  amount numeric not null,
  method text,
  external_ref text,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ── Production ─────────────────────────────────────────────────────

create table production_jobs (
  id uuid primary key default uuid_generate_v4(),
  opportunity_id uuid not null references opportunities(id),
  contract_id uuid not null references contracts(id),
  deposit_verified boolean not null default false,
  material_orders jsonb not null default '[]', -- [{supplier, amount, approved_by?, ordered_at, delivered_at}]
  crew_id uuid,
  scheduled_start date,
  scheduled_end date,
  dumpster jsonb,
  permit_status text not null default 'not_started',
  permit_jurisdiction text,
  municipal_inspections jsonb not null default '[]',
  weather_holds jsonb not null default '[]',
  install_progress jsonb not null default '[]', -- daily check-ins
  punch_list jsonb not null default '[]',
  walkthrough_at timestamptz,
  walkthrough_passed boolean,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Warranty ───────────────────────────────────────────────────────

create table warranties (
  id uuid primary key default uuid_generate_v4(),
  opportunity_id uuid not null references opportunities(id),
  customer_id uuid not null references customers(id),
  property_id uuid not null references properties(id),
  manufacturer text,
  manufacturer_registered_at timestamptz,
  manufacturer_registration_deadline date,
  labor_warranty_years int not null default 5,
  labor_certificate_url text,
  touchpoints jsonb not null default '[]', -- [{type, due, completed_at}]
  claims jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Customer memory ────────────────────────────────────────────────

create table customer_memory (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid not null references customers(id),
  category text not null check (category in (
    'conversation_summary','roof_history','insurance_history','repair_history',
    'personal_note','communication_preference','scheduling_preference',
    'referral','warranty','past_estimate','past_objection'
  )),
  content text not null,
  source department not null,
  source_ref uuid,                -- e.g. conversation id
  deleted boolean not null default false,  -- personal notes deletable on request
  created_at timestamptz not null default now()
);
create index memory_customer_idx on customer_memory (customer_id, category) where not deleted;

-- ── Event bus (append-only) ────────────────────────────────────────

create table events (
  id bigint generated always as identity primary key,
  event_type text not null,        -- e.g. 'inspection.completed'
  opportunity_id uuid references opportunities(id),
  customer_id uuid references customers(id),
  actor department not null,
  payload jsonb not null default '{}',
  processed_at timestamptz,        -- set by Operations Director
  processing_error text,
  created_at timestamptz not null default now()
);
create index events_unprocessed_idx on events (created_at) where processed_at is null;

create or replace function forbid_event_mutation() returns trigger as $$
begin
  if tg_op = 'DELETE' then raise exception 'EVENTS_IMMUTABLE: events cannot be deleted'; end if;
  -- only processing fields may change
  if old.event_type is distinct from new.event_type
     or old.payload is distinct from new.payload
     or old.actor is distinct from new.actor then
    raise exception 'EVENTS_IMMUTABLE: event content cannot be modified';
  end if;
  return new;
end; $$ language plpgsql;

create trigger events_immutable before update or delete on events
  for each row execute function forbid_event_mutation();

-- ── Tasks (work items for departments and humans) ──────────────────

create table tasks (
  id uuid primary key default uuid_generate_v4(),
  opportunity_id uuid references opportunities(id),
  owner department not null,
  title text not null,
  detail jsonb not null default '{}',
  status task_status not null default 'open',
  due_at timestamptz,
  escalate_after timestamptz,
  created_by department not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_owner_idx on tasks (owner, status);

-- ── Approvals (the single human gate queue) ────────────────────────

create table approvals (
  id uuid primary key default uuid_generate_v4(),
  action gated_action not null,
  opportunity_id uuid references opportunities(id),
  requested_by department not null,
  summary text not null,           -- what the AI wants to do
  work_product jsonb not null,     -- the complete prepared item
  reasoning text not null,         -- why the AI recommends it
  consequences text,               -- approved vs denied outcomes
  urgency text not null default 'normal' check (urgency in ('low','normal','high','critical')),
  sla_due timestamptz,
  status approval_status not null default 'pending',
  decided_by text,                 -- human identity (required on decision)
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);
create index approvals_pending_idx on approvals (status, sla_due) where status = 'pending';

create or replace function enforce_approval_decider() returns trigger as $$
begin
  if new.status in ('approved','denied') and new.decided_by is null then
    raise exception 'APPROVAL_GATE: decisions require a human identity';
  end if;
  return new;
end; $$ language plpgsql;

create trigger approvals_decider before update on approvals
  for each row execute function enforce_approval_decider();

-- ── Decisions (explainability layer) ───────────────────────────────

create table decisions (
  id bigint generated always as identity primary key,
  actor department not null,
  opportunity_id uuid references opportunities(id),
  decision text not null,          -- what was decided
  inputs jsonb not null default '{}',
  reasoning text not null,         -- why
  created_at timestamptz not null default now()
);

-- ── Automation health ──────────────────────────────────────────────

create table automation_health (
  id uuid primary key default uuid_generate_v4(),
  automation_key text not null unique,   -- e.g. 'ghl.sync', 'receptionist.sms'
  department department not null,
  status health_status not null default 'green',
  last_heartbeat timestamptz,
  last_success timestamptz,
  consecutive_failures int not null default 0,
  last_error text,
  heartbeat_expected_every interval not null default interval '15 minutes',
  updated_at timestamptz not null default now()
);

-- ── Audit log (append-only) ────────────────────────────────────────

create table audit_log (
  id bigint generated always as identity primary key,
  actor text not null,             -- department or human identity
  action text not null,
  entity_table text,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create or replace function forbid_audit_mutation() returns trigger as $$
begin
  raise exception 'AUDIT_IMMUTABLE: audit log cannot be modified or deleted';
end; $$ language plpgsql;

create trigger audit_immutable before update or delete on audit_log
  for each row execute function forbid_audit_mutation();

-- ── Stage-transition bookkeeping ───────────────────────────────────

create or replace function track_stage_entry() returns trigger as $$
begin
  if new.stage is distinct from old.stage then
    new.stage_entered_at := now();
  end if;
  new.updated_at := now();
  return new;
end; $$ language plpgsql;

create trigger opportunities_stage_entry before update on opportunities
  for each row execute function track_stage_entry();

-- ── Customers are archived, never deleted ──────────────────────────

create or replace function forbid_customer_delete() returns trigger as $$
begin
  raise exception 'CUSTOMER_GATE: customer records are archived, never deleted';
end; $$ language plpgsql;

create trigger customers_no_delete before delete on customers
  for each row execute function forbid_customer_delete();

-- ── updated_at maintenance ─────────────────────────────────────────

create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at := now(); return new; end;
$$ language plpgsql;

do $$
declare t text;
begin
  foreach t in array array['customers','properties','conversations','inspections',
    'claims','proposals','contracts','invoices','production_jobs','warranties','tasks']
  loop
    execute format('create trigger %I_touch before update on %I for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;
