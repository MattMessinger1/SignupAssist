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

    console.log('Plan scheduler running...');

    // Find plans that need to be executed soon (within 5 minutes of open time)
    const now = new Date();
    const executionWindow = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes from now

    const { data: plansToExecute, error: fetchError } = await supabase
      .from('plans')
      .select('*')
      .eq('status', 'scheduled') // Only get scheduled plans (not cancelled, executed, etc.)
      .gte('open_time', now.toISOString())
      .lte('open_time', executionWindow.toISOString());

    if (fetchError) {
      console.error('Error fetching plans:', fetchError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch plans' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Found ${plansToExecute?.length || 0} plans ready for execution`);

    if (!plansToExecute || plansToExecute.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: 'No plans ready for execution',
          executedCount: 0 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let executedCount = 0;
    const results = [];

    // Process each plan
    for (const plan of plansToExecute) {
      try {
        console.log(`Executing plan ${plan.id} for ${plan.child_name} at ${plan.org}`);

        // Update plan status to 'executing' to prevent duplicate execution
        const { error: updateError } = await supabase
          .from('plans')
          .update({ status: 'executing' })
          .eq('id', plan.id)
          .eq('status', 'scheduled'); // Only update if still scheduled

        if (updateError) {
          console.error(`Failed to update plan ${plan.id} status:`, updateError);
          results.push({ planId: plan.id, success: false, error: 'Status update failed' });
          continue;
        }

        // Log execution start
        await supabase.from('plan_logs').insert({
          plan_id: plan.id,
          msg: 'Automated execution started by scheduler'
        });

        // Execute the plan by calling run-plan function
        const { data: executionResult, error: executionError } = await supabase
          .functions
          .invoke('run-plan', {
            body: { plan_id: plan.id },
            headers: {
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
            }
          });

        if (executionError) {
          console.error(`Failed to execute plan ${plan.id}:`, executionError);
          
          // Update status back to scheduled if execution failed
          await supabase
            .from('plans')
            .update({ status: 'failed' })
            .eq('id', plan.id);

          await supabase.from('plan_logs').insert({
            plan_id: plan.id,
            msg: `Scheduled execution failed: ${executionError.message}`
          });

          results.push({ 
            planId: plan.id, 
            success: false, 
            error: executionError.message 
          });
        } else {
          console.log(`Successfully executed plan ${plan.id}`);
          executedCount++;
          results.push({ 
            planId: plan.id, 
            success: true,
            child_name: plan.child_name,
            org: plan.org
          });
        }

      } catch (error) {
        console.error(`Error processing plan ${plan.id}:`, error);
        
        // Update status to failed
        await supabase
          .from('plans')
          .update({ status: 'failed' })
          .eq('id', plan.id);

        await supabase.from('plan_logs').insert({
          plan_id: plan.id,
          msg: `Scheduled execution error: ${error.message}`
        });

        results.push({ 
          planId: plan.id, 
          success: false, 
          error: error.message 
        });
      }
    }

    console.log(`Scheduler completed: ${executedCount}/${plansToExecute.length} plans executed successfully`);

    return new Response(
      JSON.stringify({ 
        success: true,
        executedCount,
        totalPlans: plansToExecute.length,
        results
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in plan-scheduler function:', error);
    
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});