-- Add class name fields to plans table for better lesson selection
ALTER TABLE public.plans 
ADD COLUMN preferred_class_name TEXT,
ADD COLUMN alternate_class_name TEXT;

-- Add index for better performance on class name searches
CREATE INDEX idx_plans_class_names ON public.plans USING btree(preferred_class_name, alternate_class_name) WHERE preferred_class_name IS NOT NULL OR alternate_class_name IS NOT NULL;