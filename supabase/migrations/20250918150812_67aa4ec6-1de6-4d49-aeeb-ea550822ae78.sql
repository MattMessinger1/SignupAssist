-- Create session_states table for storing browser session data
CREATE TABLE public.session_states (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_id UUID NOT NULL,
  user_id UUID NOT NULL,
  cookies JSONB NOT NULL,
  storage JSONB NOT NULL, -- {local: "...", session: "..."} (stringified)
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NULL
);

-- Create indexes for performance
CREATE INDEX idx_session_states_plan_id ON public.session_states (plan_id);
CREATE INDEX idx_session_states_user_id ON public.session_states (user_id);
CREATE INDEX idx_session_states_created_at ON public.session_states (created_at DESC);

-- Enable Row Level Security
ALTER TABLE public.session_states ENABLE ROW LEVEL SECURITY;

-- Create RLS policy matching the pattern used for plans table
CREATE POLICY "owner_rw" ON public.session_states
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);