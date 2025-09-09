-- Create plan_logs table for live logging
CREATE TABLE IF NOT EXISTS public.plan_logs (
  id BIGSERIAL PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  at TIMESTAMPTZ DEFAULT now(),
  msg TEXT NOT NULL
);

-- Enable Row Level Security
ALTER TABLE public.plan_logs ENABLE ROW LEVEL SECURITY;

-- Create policy for users to read their own plan logs
CREATE POLICY "owner_read" ON public.plan_logs 
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.plans p 
  WHERE p.id = plan_id AND p.user_id = auth.uid()
));