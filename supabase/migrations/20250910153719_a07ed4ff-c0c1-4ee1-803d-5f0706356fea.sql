-- Drop the trigger if it exists
DROP TRIGGER IF EXISTS plan_status_updated_at_trigger ON plans;

-- Drop the function with CASCADE
DROP FUNCTION IF EXISTS update_plan_status_timestamp() CASCADE;

-- Recreate the function with proper security and search path
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