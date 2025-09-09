-- Drop the existing restrictive policies
DROP POLICY IF EXISTS "deny_all_select" ON account_credentials;
DROP POLICY IF EXISTS "deny_all_write" ON account_credentials;

-- Create policies that allow edge functions (service role) to access credentials
-- while maintaining user isolation for regular client access

-- Allow service role (edge functions) full access for server operations
CREATE POLICY "service_role_full_access" ON account_credentials
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Allow users to manage their own credentials through the client
CREATE POLICY "users_own_credentials" ON account_credentials
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);