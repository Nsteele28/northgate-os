# Going Live — Setup Guide

## 1. Stand up the database (15 min)

1. Create a project at supabase.com (or use your existing one).
2. In the SQL editor, run `supabase/migrations/001_core_schema.sql`, then `002_operational_config.sql`.
3. Copy the project URL and service-role key into `.env` (start from `.env.example`).

## 2. Seed your business configuration

These tables are yours to fill (humans maintain them; the AI reads them):

- **`staff`** — you, Ricky, technicians, crew leads. Set `can_approve` per person (e.g. Natalie/Ricky: everything; office manager: contract sends only).
- **`price_book`** — your real line-item pricing. The Retail Sales AI can ONLY quote from this table.
- **`jurisdictions`** — the permit rules for each city/township you work in.
- **`objection_library`** / **`knowledge_base`** — approved responses and FAQ answers. The AI never improvises outside these on regulated topics.
- **`stage_dwell_limits`** — pre-seeded with sensible defaults; tune to your reality.

## 3. Connect the integrations

Add to `.env` as you get them — each one lights up independently:

| Key | Where to get it | Unlocks |
|---|---|---|
| `GHL_API_KEY`, `GHL_LOCATION_ID` | GHL → Settings → API | CRM sync, SMS/email sending |
| `ROOFR_API_KEY` | Roofr account settings | Measurements, estimates |
| `TWILIO_*` | Twilio console | Voice + SMS fallback |
| `HAIL_SWATH_API_KEY` | HailTrace / IHM / similar | Storm verification for claims |
| `MATERIAL_ORDER_APPROVAL_LIMIT_USD` | your call | Above this, orders need approval |

NOAA weather needs no key.

## 4. The LLM brain

The conversational layer (`Brain` interface in `src/departments/framework.ts`) ships with a template implementation. Wire the Anthropic API implementation to give departments natural language — the safety rails (gates, compliance, routing) are all in code and SQL and work identically either way.

## 5. Shakedown protocol (strongly recommended)

Run each department in **propose mode** for its first week: the AI drafts every message and action as an approval-queue item, humans one-click approve. Flip to autonomous per department only after you've watched it be right. Suggested order matches the blueprint phases:

1. Receptionist + missed-call text-back (lowest risk, instant value)
2. Inside Sales cadences
3. Inspection Coordinator reminders
4. Technician Assistant checklist (hard gate active from day one)
5. Insurance packet prep (submission is permanently human-gated anyway)
6. Retail proposals → Production → Collections → Warranty → Marketing

## 6. What runs on a schedule

- `OperationsDirector.drain()` — every minute (process the event bus)
- `ExecutiveOps.sweep()` — every 15 minutes (stuck records, heartbeat gaps, overdue approvals)
- `WarrantyDepartment.sweepRegistrations()` — daily
- Lead Intelligence `generateProspects()` — daily + on new storm events

Host these on Supabase cron, a small VPS, or any scheduler — each is a single function call.
