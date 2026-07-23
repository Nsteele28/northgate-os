-- ═══════════════════════════════════════════════════════════════════
-- Migration 002: staff, price book, dwell-time limits, jurisdictions
-- ═══════════════════════════════════════════════════════════════════

create table staff (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  role text not null check (role in ('owner','manager','technician','sales','crew_lead','office')),
  phone text,
  email text,
  can_approve gated_action[],      -- which gated actions this human may approve
  skills text[],
  home_base_coords jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table price_book (
  id uuid primary key default uuid_generate_v4(),
  item_code text not null unique,
  description text not null,
  unit text not null,
  unit_price numeric not null,
  effective_from date not null default current_date,
  effective_to date,
  updated_by text not null,        -- pricing changes are always human
  created_at timestamptz not null default now()
);

-- Maximum time an opportunity may sit in a stage before Executive Ops alerts.
create table stage_dwell_limits (
  stage journey_stage primary key,
  max_dwell interval not null,
  escalation_note text
);

insert into stage_dwell_limits (stage, max_dwell, escalation_note) values
  ('new_lead',              interval '24 hours', 'Lead not enriched/scored within a day'),
  ('inbound_contact',       interval '1 hour',   'Inbound contact not routed within an hour'),
  ('outreach',              interval '30 days',  'No outreach outcome in 30 days — verify cadence is running'),
  ('inspection_scheduled',  interval '14 days',  'Inspection sitting unbooked-window too long'),
  ('inspection_in_progress',interval '12 hours', 'Inspection started but never completed'),
  ('path_decision',         interval '24 hours', 'Completed inspection not routed to insurance/retail'),
  ('claim_prep',            interval '7 days',   'Packet preparation stalled'),
  ('claim_active',          interval '21 days',  'No claim movement past carrier norm'),
  ('proposal',              interval '21 days',  'Proposal aging without close or follow-up outcome'),
  ('production_queue',      interval '30 days',  'Signed job not scheduled for production'),
  ('installing',            interval '14 days',  'Install running long'),
  ('invoicing',             interval '45 days',  'Balance outstanding past collections norm'),
  ('nurture',               interval '120 days', 'Nurture touch overdue'),
  ('emergency',             interval '15 minutes','EMERGENCY not acknowledged by a human'),
  ('parked_needs_human',    interval '24 hours', 'Parked record awaiting human too long');
-- note: warranty_active is a permanent stage with its own touchpoint timers.

create table jurisdictions (
  key text primary key,
  name text not null,
  permit_required boolean not null default true,
  permit_notes text,
  inspection_requirements jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

-- Objection library (approved responses only)
create table objection_library (
  id uuid primary key default uuid_generate_v4(),
  objection_key text not null unique,
  objection text not null,
  approved_response text not null,
  department department not null,
  approved_by text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- FAQ knowledge base for the Receptionist
create table knowledge_base (
  id uuid primary key default uuid_generate_v4(),
  topic text not null,
  question text not null,
  approved_answer text not null,
  approved_by text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
