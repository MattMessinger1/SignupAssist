-- Fix function search path security issue
DROP FUNCTION IF EXISTS update_plan_status_timestamp();

CREATE OR REPLACE FUNCTION update_plan_status_timestamp()
RETURNS TRIGGER 
LANGUAGE plpgsql 
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

-- Recreate the trigger
DROP TRIGGER IF EXISTS plan_status_updated_at_trigger ON plans;
CREATE TRIGGER plan_status_updated_at_trigger
BEFORE UPDATE ON plans
FOR EACH ROW
EXECUTE FUNCTION update_plan_status_timestamp();