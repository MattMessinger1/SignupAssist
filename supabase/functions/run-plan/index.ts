import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { plan_id } = await req.json();

    if (!plan_id) {
      return new Response(
        JSON.stringify({ error: 'plan_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Starting plan execution for plan_id: ${plan_id}`);

    // Log the start of the attempt
    const { error: logError } = await supabase
      .from('plan_logs')
      .insert({
        plan_id,
        msg: 'Attempt started - connecting to signup system...'
      });

    if (logError) {
      console.error('Failed to log attempt start:', logError);
    }

    // Get plan details
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('*')
      .eq('id', plan_id)
      .single();

    if (planError || !plan) {
      const errorMsg = 'Failed to retrieve plan details';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Error: ${errorMsg}`
      });
      
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Log plan details found
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Found plan: ${plan.child_name} at ${plan.org}`
    });

    // Get credential details
    const { data: credential, error: credError } = await supabase
      .functions
      .invoke('cred-get', {
        body: { credential_id: plan.credential_id }
      });

    if (credError || !credential?.data) {
      const errorMsg = 'Failed to retrieve credentials';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Error: ${errorMsg}`
      });
      
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Using account: ${credential.data.alias}`
    });

    // Simulate the signup process (replace with actual implementation)
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Attempting signup process...'
    });

    // Add a small delay to simulate processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // For MVP, just log success
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Signup attempt completed successfully!'
    });

    // Update plan status
    await supabase
      .from('plans')
      .update({ status: 'completed' })
      .eq('id', plan_id);

    console.log(`Plan execution completed for plan_id: ${plan_id}`);

    return new Response(
      JSON.stringify({ success: true, plan_id }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in run-plan function:', error);
    
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});