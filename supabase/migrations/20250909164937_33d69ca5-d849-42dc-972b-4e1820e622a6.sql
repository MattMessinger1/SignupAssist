-- Create secure credential storage table
create table if not exists account_credentials(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider_slug text not null,         -- e.g. 'skiclubpro'
  alias text not null,
  email_enc text not null,             -- AES-GCM JSON {iv,ct,tag}
  password_enc text not null,
  cvv_enc text,                        -- nullable
  created_at timestamptz default now()
);

-- Enable RLS and create restrictive policies
alter table account_credentials enable row level security;

-- Deny all client access - only Edge Functions can access this table
create policy "deny_all_select" on account_credentials 
  for select to authenticated using (false);

create policy "deny_all_write" on account_credentials 
  for all to authenticated using (false) with check (false);