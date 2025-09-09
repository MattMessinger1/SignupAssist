-- Create plans table for scheduled appointments
CREATE TABLE IF NOT EXISTS public.plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  provider_slug TEXT NOT NULL DEFAULT 'skiclubpro',
  org TEXT NOT NULL,
  base_url TEXT NOT NULL,
  child_name TEXT NOT NULL,
  open_time TIMESTAMPTZ NOT NULL,
  preferred TEXT NOT NULL,
  alternate TEXT,
  credential_id UUID NOT NULL REFERENCES public.account_credentials(id) ON DELETE RESTRICT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

-- Create RLS policy for users to manage their own plans
CREATE POLICY "owner_rw" ON public.plans 
FOR ALL TO authenticated 
USING (auth.uid() = user_id) 
WITH CHECK (auth.uid() = user_id);