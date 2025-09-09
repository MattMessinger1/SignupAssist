-- Add discovered_url field to plans table
ALTER TABLE public.plans 
ADD COLUMN discovered_url TEXT;

-- Create challenges table for handling user actions like CVV input
CREATE TABLE public.challenges (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_id UUID NOT NULL,
  user_id UUID NOT NULL,
  challenge_type TEXT NOT NULL, -- 'cvv', 'phone', etc.
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'completed', 'expired'
  data JSONB, -- Store challenge-specific data
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + interval '1 hour'),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS for challenges table
ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;

-- Create policies for challenges
CREATE POLICY "Users can view their own challenges" 
ON public.challenges 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own challenges" 
ON public.challenges 
FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Edge functions can insert challenges" 
ON public.challenges 
FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Edge functions can update challenges" 
ON public.challenges 
FOR UPDATE 
USING (true);

-- Create index for efficient queries
CREATE INDEX idx_challenges_plan_id ON public.challenges(plan_id);
CREATE INDEX idx_challenges_user_id ON public.challenges(user_id);
CREATE INDEX idx_challenges_status ON public.challenges(status);

-- Add foreign key constraint (optional, for data integrity)
ALTER TABLE public.challenges 
ADD CONSTRAINT fk_challenges_plan_id 
FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;