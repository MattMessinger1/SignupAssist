-- Drop the trigger first, then the function, then recreate both with proper security settings
DROP TRIGGER IF EXISTS plan_status_updated_at_trigger ON plans;
DROP FUNCTION IF EXISTS update_plan_status_timestamp();

-- Create the function with proper search path
CREATE OR REPLACE FUNCTION update_plan_status_timestamp()
RETURNS TRIGGER 
LANGUAGE plpgsql 
SECURITY DEFINER
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
CREATE TRIGGER plan_status_updated_at_trigger
BEFORE UPDATE ON plans
FOR EACH ROW
EXECUTE FUNCTION update_plan_status_timestamp();