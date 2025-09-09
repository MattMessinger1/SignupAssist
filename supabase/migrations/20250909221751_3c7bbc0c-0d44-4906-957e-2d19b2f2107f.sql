-- Enable required extensions for cron jobs
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Create a cron job to run the plan scheduler every 2 minutes
SELECT cron.schedule(
  'plan-scheduler-job',
  '*/2 * * * *', -- Every 2 minutes
  $$
  SELECT
    net.http_post(
        url:='https://pyoszlfqqvljwocrrafl.supabase.co/functions/v1/plan-scheduler',
        headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5b3N6bGZxcXZsandvY3JyYWZsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NzQzNDMzOCwiZXhwIjoyMDczMDEwMzM4fQ.wz77w5nPKVdeIUAREqoS5xQrGDyKFqZJyB-pOa2QkDI"}'::jsonb,
        body:='{"scheduled_run": true}'::jsonb
    ) as request_id;
  $$
);

-- Add a status field for tracking plan execution states
ALTER TABLE plans ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP WITH TIME ZONE DEFAULT now();

-- Add trigger to update status_updated_at when status changes
CREATE OR REPLACE FUNCTION update_plan_status_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER plan_status_updated_at_trigger
BEFORE UPDATE ON plans
FOR EACH ROW
EXECUTE FUNCTION update_plan_status_timestamp();