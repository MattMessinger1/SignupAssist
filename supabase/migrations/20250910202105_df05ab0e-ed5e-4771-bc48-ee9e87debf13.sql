-- Add provider-specific fields holder
alter table public.plans
  add column if not exists extras jsonb;

-- Optional: GIN index for extras lookups
create index if not exists idx_plans_extras_gin on public.plans using gin (extras);