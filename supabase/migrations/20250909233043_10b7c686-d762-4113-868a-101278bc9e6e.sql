-- Add missing payment authorization columns to plans table
ALTER TABLE public.plans 
ADD COLUMN expected_lesson_cost NUMERIC(10,2) DEFAULT 50.00,
ADD COLUMN max_charge_limit NUMERIC(10,2) DEFAULT 100.00;

-- Update existing plans with default values for payment authorization
UPDATE public.plans 
SET expected_lesson_cost = 75.00, 
    max_charge_limit = 100.00 
WHERE expected_lesson_cost IS NULL OR max_charge_limit IS NULL;