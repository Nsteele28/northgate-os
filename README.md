# Northgate Construction AI Operating System

The orchestration engine for an AI-powered roofing company: 13 AI departments, one shared brain, humans in control of every critical decision.

**Companion document:** `northgate-ai-operating-system-blueprint.md` — the full architecture blueprint this codebase implements.

## What's here (Phase 1–3 core, built and tested)

```
supabase/migrations/     Database schema — the single source of truth
  001_core_schema.sql      All tables + HARD GATES enforced by the DB itself
  002_operational_config.sql  Staff, price book, dwell limits, jurisdictions

src/core/                The engine
  types.ts                 Domain types
  stateMachine.ts          Journey stages, legal transitions, dwell clocks
  approvals.ts             The single human approval queue
  compliance.ts            Consent / DNC / quiet hours / opt-out (send-time gate)
  store.ts + memoryStore.ts  Storage abstraction + in-memory impl (tests/dev)

src/director/router.ts   Operations Director — event routing brain
src/departments/         The 13 AI employees (deterministic logic + pluggable Brain)
src/integrations/        GoHighLevel, Roofr, Twilio, NOAA adapters (env-configured)
src/health/executiveOps.ts  Detect → Repair → Escalate. No silent failure.

tests/system.test.ts     27 tests proving the guarantees (see below)
```

## The guarantees, as executable tests

Run `npm test`. What's proven:

- **Full journey**: storm lead → outreach → inspection → claim → contract → production → collections → warranty, routed entirely by events. No manual handoffs.
- **No stuck customers**: unroutable events park records for a human (never dropped); dwell-time sweeps catch anything that stalls; every stage can reach `parked_needs_human`.
- **Hard gates hold**: no contract sends, insurance submissions, discounts, large material orders, balance waivers, or legal escalations without an approved human decision — enforced in the engine AND again by database triggers (verified against a real PostgreSQL instance).
- **Inspections can't close incomplete**: submission throws with the exact missing items.
- **Insurance honesty**: no verifiable storm ⇒ no claim path, with an automatic honest retail fallback. Ever.
- **Compliance**: DNC blocked at lead-gen and send time; sales messages require consent; opt-out is instant, permanent, cross-channel; quiet hours enforced.
- **Self-healing**: 3 failures → red status → management paged; silent death detected via heartbeat gaps; overdue approvals escalate.
- **Leads never die**: AI moves cold leads to nurture; only humans close permanently.

## Quick start

```bash
npm install
npm test          # run the guarantee suite
npm run typecheck
```

## Going live

See `SETUP.md` for the deployment path: create the Supabase project, run migrations, add API keys to `.env`, and flip departments from propose-mode to autonomous one gate at a time.

## Design rules (do not break these)

1. Departments never call each other — they emit events; the Operations Director routes.
2. Every gated action goes through `ApprovalService`. No side doors.
3. Every outbound message goes through `CommsService.send()`. No direct transport calls.
4. The `Brain` drafts language; it never gates. Safety lives in code and SQL.
5. Supabase is canonical. GHL/Roofr are mirrored surfaces.
