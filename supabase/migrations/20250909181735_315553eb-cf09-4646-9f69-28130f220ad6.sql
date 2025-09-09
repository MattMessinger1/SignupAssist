-- Drop existing challenges table and recreate with token-based design
DROP TABLE IF EXISTS public.challenges CASCADE;

-- Create challenges table with token-based design
CREATE TABLE IF NOT EXISTS public.challenges (
  token TEXT PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- 'cvv' | 'captcha'
  status TEXT NOT NULL DEFAULT 'pending',
  data JSONB, -- Store challenge-specific data like encrypted CVV
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Enable RLS
ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;

-- Create policy for authenticated users to read their own challenges
CREATE POLICY "owner_read" ON public.challenges 
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.plans p WHERE p.id = plan_id AND p.user_id = auth.uid()));

-- Create policy for edge functions to insert and update challenges
CREATE POLICY "edge_functions_write" ON public.challenges
FOR ALL
USING (true)
WITH CHECK (true);

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_challenges_plan_id ON public.challenges(plan_id);
CREATE INDEX IF NOT EXISTS idx_challenges_token ON public.challenges(token);
CREATE INDEX IF NOT EXISTS idx_challenges_status ON public.challenges(status);