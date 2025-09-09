-- Add paid field to plans table to track payment status
ALTER TABLE public.plans 
ADD COLUMN paid BOOLEAN NOT NULL DEFAULT false;