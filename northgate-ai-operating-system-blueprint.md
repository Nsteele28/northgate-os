# Northgate Construction AI Operating System
## Master Architecture Blueprint — Full Company Expansion

**Prepared for:** Natalie & Ricky, Northgate Construction
**Date:** July 23, 2026
**Status:** Build specification — Phase 2+ expansion beyond the lead-generation system

---

## 1. What This Document Is

This is the master build specification for the complete Northgate Construction AI Operating System: an AI-powered roofing company where specialized AI employees run every repeatable process — reception, lead intelligence, inside sales, inspections, insurance, retail sales, production, collections, warranty, customer success, marketing, and executive operations — while humans retain control of pricing, legal, safety, compliance, and final business decisions.

This is not a collection of isolated automations. It is one connected system built on four commitments:

1. **Nothing gets stuck.** Every AI employee, when it finishes its responsibility, hands the customer to the next department. There is no state a customer can sit in without an owner and a next action.
2. **Everything is logged.** Every action writes to an immutable event log with who/what/when/why.
3. **Everything is explainable.** Every decision an AI employee makes is stored with its reasoning, so a human can audit it later.
4. **Everything is recoverable.** Every automation has defined failure behavior: retry, escalate, or park with an alert — never silent failure.

---

## 2. Core Architecture

### 2.1 The shape of the system

```
                    ┌─────────────────────────────┐
                    │   OPERATIONS DIRECTOR AI     │
                    │  (orchestrator + router)     │
                    └──────────┬──────────────────┘
                               │ reads/writes
                    ┌──────────▼──────────────────┐
                    │      SHARED DATA LAYER       │
                    │  Supabase (source of truth)  │
                    │  + GoHighLevel (CRM/comms)   │
                    │  + Roofr (measure/proposals) │
                    │  + Document storage          │
                    └──────────┬──────────────────┘
                               │ subscribed to by
   ┌───────────┬───────────┬───┴───────┬───────────┬────────────┐
   │Reception  │Lead Intel │Inside     │Inspection │Technician  │
   │           │           │Sales      │Coordinator│Assistant   │
   ├───────────┼───────────┼───────────┼───────────┼────────────┤
   │Insurance  │Retail     │Production │Collections│Warranty    │
   │Coordinator│Sales      │Manager    │Manager    │Dept        │
   ├───────────┴───────────┼───────────┴───────────┴────────────┤
   │Customer Success Mgr   │Marketing Dept                       │
   └───────────────────────┴─────────────────────────────────────┘
                               │ all monitored by
                    ┌──────────▼──────────────────┐
                    │   EXECUTIVE OPERATIONS AI    │
                    │ (health, alerts, self-heal)  │
                    └─────────────────────────────┘
```

**Supabase is the single source of truth.** GoHighLevel remains the CRM and communication engine (SMS, email, calendars, pipelines), and Roofr remains the measurement/proposal tool — but every record they hold is mirrored into Supabase, and Supabase holds the canonical state. When GHL and Supabase disagree, a sync-repair job reconciles them and logs the discrepancy. This rule exists because a multi-department AI system cannot reason reliably over three partially-overlapping databases.

### 2.2 The Operations Director

The Operations Director is not a chatbot — it is the routing brain. It runs on two mechanisms:

**A. The journey state machine.** Every customer has exactly one `journey_stage` at all times. The legal stages and their owning departments:

| Stage | Owning department | Exit condition |
|---|---|---|
| `new_lead` | Lead Intelligence | Enriched, scored, compliance-checked → `outreach` |
| `inbound_contact` | Receptionist | Intent identified → `outreach`, `inspection_scheduling`, or `emergency` |
| `outreach` | Inside Sales | Inspection booked → `inspection_scheduled`; or long-term nurture |
| `inspection_scheduled` | Inspection Coordinator | Appointment confirmed and routed → `inspection_in_progress` |
| `inspection_in_progress` | Technician Assistant | Documentation complete + quality-scored → `path_decision` |
| `path_decision` | Operations Director | Insurance path → `claim_prep`; retail path → `proposal` |
| `claim_prep` | Insurance Coordinator | Packet approved by human + claim filed → `claim_active` |
| `claim_active` | Insurance Coordinator | Claim approved → `proposal`; denied → `path_decision` (retail fallback) |
| `proposal` | Retail Sales | Contract signed + deposit → `production_queue` |
| `production_queue` | Production Manager | Materials, crew, permits ready → `installing` |
| `installing` | Production Manager | Final walkthrough passed → `invoicing` |
| `invoicing` | Collections Manager | Balance = $0 → `warranty_active` |
| `warranty_active` | Warranty Department | Permanent (annual/5-year touchpoints, referrals) |
| `nurture` | Inside Sales | Re-engagement → `outreach` |
| `emergency` | Receptionist → human | Human takes over immediately |
| `parked_needs_human` | Executive Ops | Human resolves → returns to prior stage |

Every stage transition is an event. Every stage has a **maximum dwell time**; exceeding it fires a stuck-pipeline alert to Executive Ops (see §6). This is the structural guarantee that no workflow gets stuck: a customer is always in a stage, every stage has an owner, and every stage has a clock.

**B. The event bus.** Departments never call each other directly. They emit events (`inspection.completed`, `claim.approved`, `payment.received`) to an `events` table; the Operations Director consumes events, applies routing rules, transitions the journey stage, and creates a task for the receiving department. This decoupling is what makes the system recoverable — if a department is down, its events queue rather than vanish.

### 2.3 Shared data model (Supabase)

Core tables. Every table carries `created_at`, `updated_at`, and every mutation is mirrored to `audit_log`.

- **`customers`** — identity, contact info, communication preferences, DNC/consent flags, GHL contact ID. One row per human. Duplicate prevention: unique fuzzy-match index on normalized phone + email + name/address; merges are logged, never deletes.
- **`properties`** — address, parcel data, roof material, roof age, measurements (Roofr), storm-event history. A customer can own multiple properties; a property can change owners.
- **`opportunities`** — one row per potential/active job. Holds `journey_stage`, path (insurance/retail), value, source attribution. This is the object that moves through the state machine.
- **`conversations`** — every message across every channel (call transcript, SMS, email, web chat, FB Messenger, GBP), unified per customer. All AI employees read the same thread; no department is ever blind to what another said.
- **`inspections`** — appointment, technician, checklist state, photos/videos manifest, measurements, quality score, completion status.
- **`claims`** — carrier, claim number, adjuster, status, timeline milestones, supplements, evidence packet reference, storm verification data.
- **`contracts_invoices_payments`** — proposals, signed contracts, invoices, payments, balances, mortgage-company and insurance-payment tracking.
- **`production_jobs`** — material orders, crew schedule, dumpster, permits, build dates, punch list, walkthrough, completion cert.
- **`warranties`** — registrations, manufacturer + labor terms, inspection schedule (1yr/5yr), claims against warranty.
- **`customer_memory`** — the permanent memory store (see §5).
- **`events`** — the event bus. Immutable, append-only.
- **`tasks`** — work items for AI departments and humans, with owner, due time, and escalation rules.
- **`approvals`** — the human approval queue (see §4).
- **`decisions`** — every non-trivial AI decision with inputs, reasoning, and outcome. This is the explainability layer.
- **`automation_health`** — per-automation heartbeats, error counts, last success (see §6).
- **`audit_log`** — append-only record of every action by every actor, human or AI.

### 2.4 Integration map

| System | Role | Owned by |
|---|---|---|
| **GoHighLevel** | CRM pipelines, SMS/email/calls, calendars, forms, review requests | All customer-facing departments |
| **Supabase** | Canonical database, event bus, memory, audit, dashboards | Everything |
| **Roofr** | Roof measurements, estimates, proposals | Technician Assistant, Retail Sales |
| **Telephony (GHL/Twilio)** | Inbound/outbound voice, missed-call text-back, voicemail transcription | Receptionist, Inside Sales |
| **Weather data (NOAA + hail-swath provider)** | Storm verification, weather matching, production weather monitoring | Lead Intelligence, Insurance, Production |
| **Property data provider** | Parcel/owner enrichment | Lead Intelligence |
| **E-signature** | Contracts, authorizations | Retail Sales (send requires human approval) |
| **Payments/financing** | Deposits, invoices, financing applications | Retail Sales, Collections |
| **Google Business / Facebook** | Messaging channels, reviews | Receptionist, Marketing |

Every integration gets: an adapter with retry + exponential backoff, a heartbeat row in `automation_health`, and a sync-reconciliation job (GHL↔Supabase, Roofr↔Supabase) that repairs drift and reports discrepancies rather than silently overwriting.

---
## 3. The Thirteen AI Departments

Each department follows the same template: what triggers it, what it does, where it hands off, what requires a human, how it fails safely, and how it's measured. All departments read/write the shared data layer and speak through the event bus.

### 3.1 AI Receptionist — "never miss a contact"

**Triggers:** inbound call, SMS, website chat, FB Messenger, Google Business message, voicemail, missed call.

**Behavior:**
- Answers within seconds on every channel, 24/7, using the customer's full history from `conversations` and `customer_memory` — returning customers are recognized and greeted with context.
- Missed-call text-back fires within 60 seconds of any unanswered call.
- Classifies every contact into: **emergency** (active leak, storm damage in progress, safety issue) → immediately pages the on-call human AND begins collecting address/photos while help is arranged; **new inquiry** → qualifies lightly and hands to Inside Sales or books the inspection directly; **existing customer** → routes to the owning department (production question → Production Manager's comms via Customer Success; billing → Collections; warranty → Warranty); **complex/upset** → escalates to a human with a full summary, never argues.
- Answers FAQs (services, service area, financing availability, insurance process, timelines) from a curated knowledge base — never improvises pricing.

**Hands off to:** Inside Sales (`outreach`), Inspection Coordinator (booking made), any owning department, or a human (emergency/complex).
**Human gates:** never quotes prices; never makes contractual commitments; emergencies always page a human.
**Failure mode:** if the AI can't respond on a channel, the missed-call text-back and a human alert both fire — a customer never gets pure silence.
**KPIs:** answer rate, median response time per channel, booking conversion from inbound, escalation accuracy.

### 3.2 AI Lead Intelligence — "tomorrow's customers, found today"

**Triggers:** daily schedule; new storm event; new data-provider delivery.

**Behavior:**
- Matches storm swaths (hail size, wind speed, date) against the service area; identifies affected neighborhoods.
- Pulls property data for affected parcels; enriches with roof age indicators, property value, ownership.
- Scores each opportunity (storm severity × roof age × property profile × proximity to existing jobs — neighborhoods where Northgate already has a job score higher).
- Enriches contact data, then runs **compliance verification before any record becomes contactable**: DNC registry check, consent status, state/local solicitation rules. Non-compliant records are stored but flagged `do_not_contact` — they are never handed to Inside Sales.
- Creates CRM records in GHL + Supabase with full source attribution; duplicate check against existing customers/properties before insert (match on normalized address + owner; near-matches go to a review queue rather than auto-merging).
- Delivers a scored daily prospect list to Inside Sales, capped at what Inside Sales can genuinely work.

**Hands off to:** Inside Sales (`new_lead` → `outreach`).
**Human gates:** none for research; DNC/compliance flags can only be overridden by a human, with the override logged.
**Failure mode:** if a data source fails, yesterday's pipeline is not re-sent; Executive Ops is alerted and the day's generation is marked degraded, not silently empty.
**KPIs:** prospects/day, score-to-inspection conversion, duplicate rate, compliance flag accuracy.

### 3.3 AI Inside Sales Representative — "every lead worked forever"

**Triggers:** new scored lead; inbound handoff from Receptionist; follow-up timer; no-show event; nurture re-engagement signal (e.g., new storm hits a nurture-stage property).

**Behavior:**
- Multi-channel outreach sequences (SMS-first, then call, then email) with timing rules that respect quiet hours and channel consent per contact.
- Qualifies: roof age, damage observed, insurance carrier, ownership, timeline. Records everything to the shared record.
- Handles objections from an approved objection library ("insurance won't cover it," "we're getting other quotes," "not right now") — honest, pressure-free, never invents claims about insurance outcomes.
- Books inspections directly onto real technician availability (via Inspection Coordinator's calendar service). Sends confirmation immediately.
- **Follows up indefinitely.** No lead is ever closed by the AI — dead-end leads move to `nurture` with a long-cycle cadence (quarterly touch, storm-triggered reactivation). Only a human can mark a lead permanently dead (or a legal reason: DNC request, which the AI honors instantly and permanently).
- No-show recovery: immediate warm reschedule sequence, then decaying cadence.

**Hands off to:** Inspection Coordinator (`inspection_scheduled`); nurture pool.
**Human gates:** none for standard outreach; any customer who asks for a human gets one; opt-outs processed instantly and irreversibly by the AI.
**Failure mode:** failed sends retry then alert; a lead with no next-scheduled-action is by definition a bug and fires a stuck alert.
**KPIs:** contact rate, qualification rate, inspections booked, show rate, nurture reactivation rate.

### 3.4 AI Inspection Coordinator — "the right tech, the right roof, the right time"

**Triggers:** inspection booked; day-of schedule; technician status events; weather forecast changes.

**Behavior:**
- Assigns technicians by availability, skills, and geography; optimizes daily routes to minimize drive time and cluster neighborhoods.
- Manages the real calendar (GHL calendars as the booking surface, Supabase as truth).
- Reminder ladder to the homeowner: 48h, 24h, morning-of, and "tech is on the way" with name/photo/ETA when GPS shows the tech en route.
- Notifies technicians of their schedule the evening before and of any day-of changes instantly; tracks arrival via the Technician Assistant's GPS check-in.
- Weather-aware: if forecast makes inspections unsafe/pointless, proactively reschedules with apologetic, human-sounding messages before the customer has to ask.

**Hands off to:** Technician Assistant (`inspection_in_progress` at GPS arrival).
**Human gates:** none; technicians can decline/flag assignments, which reroutes.
**Failure mode:** unconfirmed appointments escalate to a call; tech no-shows page a human dispatcher.
**KPIs:** show rate, on-time arrival rate, drive time per inspection, same-week booking availability.

### 3.5 AI Technician Assistant — "no inspection closes incomplete"

**Triggers:** GPS arrival at the property; checklist item events; submission attempt.

**Behavior:**
- Runs the on-site protocol as a guided mobile flow: GPS-verified arrival → checklist → required photo set (elevations, slopes, damage close-ups with reference object, gutters, vents/penetrations, interior if applicable) → required video walkthrough → measurement verification against Roofr → roof material and age capture → damage documentation (type, severity, location mapped) → interior damage → insurance info (carrier, policy if shared) → customer notes.
- **Hard gate: the inspection cannot be submitted until every required item is present.** Missing items produce specific, real-time prompts to the tech while they're still on the roof — not a rejection email two days later.
- Scores inspection quality (photo coverage, clarity, documentation completeness); low scores flag coaching opportunities to management.
- On completion, produces a structured damage summary that feeds both the insurance packet and the retail proposal.

**Hands off to:** Operations Director (`path_decision`: evidence supports an insurance claim → Insurance Coordinator; retail-appropriate → Retail Sales).
**Human gates:** the damage assessment itself is the technician's — the AI structures and enforces documentation, it does not invent damage.
**Failure mode:** offline-capable capture with sync-on-signal; a completed-but-unsynced inspection alerts after 2 hours.
**KPIs:** first-submission completeness rate, average quality score, time-on-site, missing-doc alerts per inspection.

### 3.6 AI Insurance Coordinator — "airtight packets, honest claims"

**Triggers:** `path_decision` → insurance; claim status changes; adjuster events; carrier correspondence; timeline timers.

**Behavior:**
- **Storm verification first.** Confirms a verifiable weather event (date, hail size/wind speed from NOAA + swath data) matches the property and the damage pattern. **If verification fails, the claim path stops** — the AI never fabricates storm data and never recommends filing an unsupported claim. The customer is routed to retail options instead, honestly.
- Builds the evidence packet: organized photos (labeled, mapped to damage points), storm report, measurements, technician summary, carrier-specific formatting (each carrier's known documentation preferences are templated).
- **Human approval gate: no packet leaves the building without sign-off.** The AI presents the packet + a recommendation + its reasoning; a human approves submission.
- Schedules and preps adjuster meetings (technician briefed with the packet beforehand); tracks the claim through every milestone with carrier-specific expected timelines; chases missing docs; detects stalled claims and drafts follow-ups.
- Tracks supplements: compares approved scope against actual scope, identifies legitimate missed items, drafts supplement requests — again, human-approved before submission.

**Hands off to:** Retail Sales (`proposal`) on approval; `path_decision` on denial (retail fallback, honestly presented).
**Human gates:** all external submissions; all supplement filings; any communication with the carrier beyond status checks.
**Failure mode:** claims with no movement past the carrier's expected timeline escalate to a human with a drafted nudge.
**KPIs:** packet first-pass approval rate, claim cycle time, supplement capture rate, zero unsupported-claim incidents (hard requirement).

### 3.7 AI Retail Sales Coordinator — "from yes to signed without friction"

**Triggers:** `proposal` stage entry; proposal viewed/ignored events; signature events; deposit events.

**Behavior:**
- Builds the proposal from Roofr estimates + inspection data: good/better/best options, financing presentation with real monthly-payment framing, warranty comparison.
- **Pricing comes from the configured price book. Any deviation — discounts, price matching, custom line items — routes to a human for approval before the customer sees it.**
- Delivers the proposal, tracks opens/views, follows up on a cadence tuned to engagement (viewed-but-silent gets a different message than never-opened).
- Handles objections from the approved library; presents financing options and pre-qualification links; collects deposit; runs e-signature — **contract send itself requires human approval** (a one-click approve in the queue once the human has reviewed terms).
- Contract reminders until signed; celebrates signing with a warm welcome-to-production message.

**Hands off to:** Production Manager (`production_queue`) once signed + deposit verified.
**Human gates:** all pricing changes and discounts; contract dispatch.
**KPIs:** proposal-to-close rate, time-to-close, financing attach rate, average approved-without-discount rate.

### 3.8 AI Production Manager — "signed to shingled without dropped balls"

**Triggers:** contract signed + deposit verified; supplier events; permit events; weather forecasts; crew check-ins; daily schedule.

**Behavior:**
- Verifies deposit cleared before anything is ordered.
- Orders materials against the contract scope (**orders above the configured spend limit require human approval**); tracks delivery confirmations.
- Schedules crews and dumpsters; monitors permit application → approval; schedules required municipal inspections.
- Watches weather 10 days out for every scheduled install; proactively reschedules and notifies the customer (via Customer Success) before weather becomes a surprise.
- Tracks installation day: crew arrival, progress check-ins, photo documentation.
- Generates the daily production report for management; generates the punch list from crew close-out + photo review; schedules final walkthrough; verifies completion (photos, punch list cleared, customer sign-off) before releasing to invoicing.

**Hands off to:** Collections Manager (`invoicing`); Customer Success at every milestone; Warranty Department at completion.
**Human gates:** material orders above limit; schedule commitments that would incur overtime/rush fees.
**Failure mode:** any job in `production_queue` with a missing prerequisite (no permit motion in X days, materials undelivered 48h before build) fires a specific alert, not a generic one.
**KPIs:** contract-to-install days, weather-reschedule lead time, punch-list items per job, on-budget material rate.

### 3.9 AI Collections Manager — "polite, persistent, precise"

**Triggers:** completion verified; payment events; due-date timers; mortgage/insurance check events.

**Behavior:**
- Generates the final invoice from the contract + approved supplements; delivers with payment links.
- Reminder ladder: friendly → firm → past-due, always accurate to the penny and aware of what's already been paid.
- Tracks the messy realities of roofing money: insurance ACV/depreciation releases, mortgage-company endorsement processes (guides the homeowner through their mortgage company's inspection/endorsement steps), financing disbursements.
- Reconciles every payment against the balance in real time; payment confirmations go out instantly via Customer Success.
- **Legal escalation (liens, collections agencies, demand letters) is prepared by the AI — timeline, documentation, drafted notice — but only a human can pull the trigger.** The AI never waives balances or negotiates settlements; it routes those requests to a human with full context.

**Hands off to:** Warranty Department (`warranty_active` at zero balance); Marketing (review request fires at zero balance, not before).
**Human gates:** legal action; balance adjustments; settlements.
**KPIs:** DSO, % collected within 30 days, mortgage-endorsement cycle time.

### 3.10 AI Warranty Department — "the relationship after the roof"

**Triggers:** job completion; registration deadlines; anniversary timers; inbound warranty claims.

**Behavior:**
- Registers manufacturer warranties within the registration window (missing a registration deadline is treated as a critical failure); issues Northgate's labor warranty certificate.
- Schedules and runs the touchpoint calendar: 1-year inspection offer, 5-year inspection, seasonal maintenance reminders (gutter, sealant, storm-season checkup).
- Handles inbound warranty claims: collects photos, checks coverage against terms, schedules the service visit, tracks resolution.
- Recognizes lifecycle opportunities: aging roofs on past customers' *other* properties, family referrals, repeat business — feeds these to Marketing and Inside Sales as warm opportunities.

**Human gates:** coverage disputes (AI presents the terms + evidence; human decides).
**KPIs:** registration compliance (must be 100%), touchpoint completion, warranty claim resolution time, repeat/referral revenue from warranty base.

### 3.11 AI Customer Success Manager — "the voice of the company"

This department owns the *outbound narrative* to the homeowner across the whole journey. Other departments decide *what* is happening; Customer Success decides *how it's said*.

**Behavior:**
- Sends every lifecycle communication: appointment reminders, "your crew arrives at 7:30 tomorrow — here's the foreman, Luis," material delivery heads-up ("a truck will drop shingles on your driveway Thursday"), weather-delay apologies with new dates, daily production updates, completion congratulations, payment confirmations, warranty walkthrough, review and referral requests.
- Every message is personalized from `customer_memory` (preferred channel, preferred name, past context — "hope the kitchen ceiling repair from the leak is holding up well") and written to sound like a person, not a pipeline.
- Detects sentiment in replies; anything frustrated or confused escalates to a human *before* it becomes a complaint.

**Human gates:** none for templated lifecycle comms; escalation-worthy replies always reach a human.
**KPIs:** customer satisfaction, reply sentiment trend, "where's my…?" inbound rate (a good Customer Success AI drives this toward zero because customers are told before they wonder).

### 3.12 AI Marketing Department — "every finished roof sells the next one"

**Triggers:** zero-balance event; completion photos available; neighborhood job-density signals; campaign schedules.

**Behavior:**
- Review engine: requests Google/Facebook reviews at the happiness peak (completion + paid), routes unhappy signals to a human instead of a review link, tracks review velocity.
- Referral engine: structured referral asks with tracking, referral-source attribution back into Lead Intelligence.
- Content engine: drafts before/after posts from production photos (**human approves anything published publicly**).
- Neighborhood engine: detects streets/subdivisions with completed jobs + storm history and generates "we just did your neighbor's roof" campaigns for Lead Intelligence to score and Inside Sales to work.
- Tracks source → revenue attribution for every campaign; reports ROI to the dashboard.

**Human gates:** public content publication; any paid spend.
**KPIs:** reviews/month, referral rate, neighborhood campaign conversion, marketing ROI by source.

### 3.13 AI Executive Operations — "the department that watches the departments"

**Triggers:** continuous; heartbeat misses; error events; threshold breaches; dwell-time violations.

**Behavior:** see §6 (Self-Healing System) — Executive Ops is that system's owner. It monitors broken automations, failed integrations, API failures, duplicate contacts, pipeline bottlenecks, stuck opportunities, missed appointments, missing documents, incomplete inspections, failed SMS/email, and Roofr/GHL sync drift. It fixes what it safely can, escalates what it can't, and reports everything to the dashboard and to management alerts.

---
## 4. Human Approval Gates — The Approval Queue

Approval isn't scattered across departments; it is one system. Every gated action creates a row in `approvals` and appears in a single queue on the executive dashboard (and as a push/SMS notification for time-sensitive items).

**Every approval request contains:** what the AI wants to do, the complete prepared work product (the packet, the contract, the discount math, the order), *why* the AI recommends it (reasoning from `decisions`), what happens if approved vs. denied, and a deadline/urgency level. The human's job is a decision, never assembly.

**The gated actions (AI may never do these alone):**

| Action | Prepared by | Approver sees |
|---|---|---|
| Change contract pricing / approve discounts | Retail Sales | Original vs. proposed price, margin impact, customer context |
| Waive or adjust balances | Collections | Balance history, customer situation, precedent |
| Create/send legal documents | Collections / Retail | Full drafted document with sources |
| Send contracts | Retail Sales | Complete contract, terms summary, deviations from standard |
| Submit insurance packets externally | Insurance | Full packet, storm verification evidence, carrier |
| File supplements | Insurance | Scope comparison, justification per line |
| Order materials above spend limit | Production | Order, budget vs. actual, supplier terms |
| Cancel signed contracts | (human-initiated only) | — |
| Delete customer records | (never; merge/archive only, human-approved) | — |
| Override compliance rules (DNC, consent) | (human-initiated only, logged permanently) | — |
| Publish public marketing content | Marketing | Final asset, where it posts |
| Initiate legal collection action | Collections | Timeline, documentation, drafted notice |

**Queue rules:** approvals have SLAs (e.g., contract sends reviewed within 4 business hours); overdue approvals escalate from Natalie/Ricky's queue to SMS nudge; every approve/deny is logged with the human's identity; a denial returns the item to the owning department with the human's note, and the AI revises rather than abandons.

---

## 5. Customer Memory

`customer_memory` is a permanent, structured store per customer, written to by every department and read before every interaction. It is what makes year-three conversations feel like talking to a company that knows you.

**What is remembered:** every conversation summary (full transcripts remain in `conversations`; memory holds the distilled facts), roof history (materials, repairs, storm damage by date), insurance history (carrier, past claims, outcomes), previous estimates and why they didn't close, past objections and how they were resolved, communication preferences (channel, time of day, tone — "prefers texts, hates calls during work hours"), scheduling preferences, voluntarily shared family/personal notes ("son plays at Central High," "recently retired"), referral history in both directions, and warranty history.

**Rules:** memory entries carry source + timestamp; personal notes are only ever facts the customer volunteered, used for warmth, never for pressure; customers can request their record and request deletion of personal notes (compliance requirement); memory is injected into every AI employee's context at conversation start — the Receptionist answering a 2 a.m. text knows what the technician wrote at the kitchen table three years ago.

---

## 6. Self-Healing System (owned by Executive Operations)

Three layers, from automatic to human:

**Layer 1 — Detect.** Every automation writes heartbeats and outcomes to `automation_health`. Detection covers: integration/API failures (GHL, Roofr, telephony, weather, payments), failed SMS/email sends, sync drift between systems, duplicate contact creation, journey-stage dwell-time violations (stuck opportunities), missed appointments without recovery action, inspections incomplete past their appointment window, documents missing past their stage requirements, and anomaly detection on volume (e.g., "zero leads generated today" or "SMS delivery rate dropped 40%").

**Layer 2 — Repair.** For known failure classes, Executive Ops acts alone: retry with backoff for transient API errors; re-queue and re-send failed messages (with dedupe so customers never get doubles); re-run sync reconciliation for drift; merge-queue for detected duplicates; re-fire the recovery sequence for missed appointments. Every repair is logged with cause and action.

**Layer 3 — Escalate.** Anything unrepaired within its threshold pages management with: what broke, who it affects (which customers, which jobs), what was tried, and the recommended human action. Escalations are severity-tiered: **critical** (customer-facing failure in progress — e.g., inbound calls unanswered) pages immediately; **degraded** (a department limping — retries succeeding but slow) goes to the daily ops digest; **hygiene** (duplicates, stale data) goes to a weekly review queue.

**The prime directive: no silent failure.** Every failure produces either a logged successful repair or a human notification. A failure that produces neither is itself detectable (heartbeat gap) and alerts.

---

## 7. Executive Dashboard

One live dashboard for Natalie and Ricky, backed directly by Supabase. Four zones:

**Money** — revenue (sold / installed / collected), cash expected vs. collected timeline, collections aging, claims value in pipeline, supplements pending/approved, marketing ROI by source.

**Pipeline** — jobs sold, jobs installed, production schedule (calendar view with weather overlay), upcoming inspections, claims by status, stuck-opportunity list (dwell-time violators, one click to the full record), lead sources this month, weather opportunities (fresh storm swaths scored by Lead Intelligence).

**People** — sales leaderboard, technician leaderboard (inspection quality scores, on-time rate), pending approvals queue (the §4 queue lives here, front and center), customer satisfaction trend, review + referral generation.

**System health** — automation health board (green/yellow/red per department), system errors and open escalations, sync status per integration, message delivery rates.

Every number is drillable to the underlying records, because a dashboard you can't interrogate is a dashboard you stop trusting.

---
## 8. Compliance Guardrails (built into the system, not bolted on)

**Outreach compliance (TCPA / DNC / state solicitation law):** every outbound text and call checks consent status and DNC flags at send time, not just at list-build time; quiet hours enforced per timezone; opt-outs ("STOP", "remove me", or any natural-language equivalent) are honored instantly, permanently, and across all channels; frequency caps prevent over-messaging; every message logs its consent basis. Lead Intelligence's compliance verification (§3.2) is the front gate; send-time checking is the back gate.

**Insurance integrity:** storm claims require verified weather data matched to the property and damage pattern; the AI never coaches homeowners to claim damage that isn't documented, never inflates scopes, and never predicts claim outcomes as promises; all carrier-bound documents pass the human gate. This is both legal protection and the reputation the company runs on.

**Licensing & permits:** production cannot schedule a build without permit status satisfied for that jurisdiction; jurisdiction rules live in a maintained table, and jobs in unknown jurisdictions park for human review rather than guessing.

**Data protection:** customer PII lives in Supabase with row-level security; payment data never touches the database (processor-hosted only); customers can request their data and deletion of personal notes; every access is in the audit log.

---

## 9. Phased Build Roadmap

The phases are sequenced so each one produces standalone value while laying rails for the next, and so the monitoring layer exists *before* the volume arrives.

**Phase 1 — Foundation & Spine** *(everything depends on this)*
Supabase canonical schema (§2.3) stood up; GHL↔Supabase sync with reconciliation; the event bus and `journey_stage` state machine; audit log and `decisions` logging; the approval queue (even if the first approvals arrive by SMS link). Exit test: a customer record can move through stages by events, every move is logged, and an approval round-trips.

**Phase 2 — Front of Funnel** *(revenue impact first)*
AI Receptionist (all channels + missed-call text-back + emergency routing); AI Inside Sales (sequences, booking, indefinite follow-up); Inspection Coordinator (scheduling, reminders, routing). Lead Intelligence expands from the existing lead-gen phase onto the new spine with compliance verification. Exit test: an inbound text at midnight becomes a booked, confirmed, technician-routed inspection with zero human touches.

**Phase 3 — The Field & The Fork**
Technician Assistant (checklist enforcement, hard completeness gate, quality scoring); the `path_decision` routing; Insurance Coordinator (storm verification, packet building, human-gated submission, claim tracking); Retail Sales Coordinator (proposals, financing, gated contract send, deposits). Exit test: a completed inspection becomes either a human-approved insurance packet or a delivered proposal with no manual assembly.

**Phase 4 — Production & Money**
Production Manager (materials, crews, permits, weather, walkthrough); Collections Manager (invoicing, reminder ladder, mortgage/insurance payment tracking, gated legal prep); Customer Success narration switched on across the whole journey. Exit test: a signed contract reaches "paid in full" with the homeowner informed at every step and no dropped prerequisite.

**Phase 5 — The Long Tail & The Flywheel**
Warranty Department (registrations, touchpoint calendar, claims); Marketing Department (reviews, referrals, neighborhood campaigns, attribution). Exit test: completed jobs automatically generate reviews, referrals, and scored neighborhood prospects that flow back into Phase 2.

**Phase 6 — Full Executive Layer**
Executive Operations matured from basic alerting (which ships in Phase 1) to full self-healing (§6); the complete executive dashboard (§7); anomaly detection tuned on real volume. Exit test: a deliberately injected failure (kill an API key) is detected, retried, escalated, and visible on the dashboard without anyone being told to look.

Each phase ends with a shakedown week: run the new departments in "propose mode" (AI drafts, human sends) before flipping to autonomous mode, gate by gate.

---

## 10. Operating Principle

The objective is not to automate tasks. It is a roofing company where an experienced office staff, sales team, production department, insurance department, customer service team, and operations manager work together 24 hours a day — and where Natalie and Ricky's time is spent only on the decisions that genuinely require an owner: pricing, legal, compliance, safety, and strategy. Every repetitive task discovered in operation should be evaluated for safe automation and, if safe, absorbed into the appropriate department. Every customer moves from first contact to lifetime warranty relationship with no manual intervention except the human approval gates — and every one of those gates exists on purpose.



