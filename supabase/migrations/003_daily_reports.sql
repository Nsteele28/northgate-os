-- KPI daily reporting
create table if not exists daily_reports (
  id bigint generated always as identity primary key,
  report_date date not null unique,
  kpis jsonb not null,
  wins jsonb not null default '[]',
  concerns jsonb not null default '[]',
  recommendations jsonb not null default '[]',
  narrative text,
  created_at timestamptz not null default now()
);
alter table conversations add column if not exists script_tag text;
create index if not exists conversations_dir_day on conversations (direction, occurred_at);
