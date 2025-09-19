-- Add RLS policy to allow users to insert logs for their own plans
CREATE POLICY "owner_insert_logs" ON plan_logs
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM plans p 
    WHERE p.id = plan_logs.plan_id 
    AND p.user_id = auth.uid()
  )
);

-- Add RLS policy to allow edge functions to insert logs (for system operations)
CREATE POLICY "system_insert_logs" ON plan_logs
FOR INSERT
TO service_role
WITH CHECK (true);