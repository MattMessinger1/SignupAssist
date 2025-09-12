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
      Deno.env.get('SB_URL') ?? '',
      Deno.env.get('SB_SERVICE_ROLE_KEY') ?? '',
    );

    console.log('Plan scheduler running...');

    // Find plans ready for execution (60 seconds before signup time, up to 5 minutes late)
    const now = new Date();
    const lateWindow = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago
    const earlyExecutionTime = new Date(now.getTime() + 60 * 1000); // 60 seconds from now

    const { data: plansToExecute, error: fetchError } = await supabase
      .from('plans')
      .select('*')
      .eq('status', 'scheduled') // Only get scheduled plans (not cancelled, executed, etc.)
      .gte('open_time', lateWindow.toISOString()) // Not more than 5 minutes late
      .lte('open_time', earlyExecutionTime.toISOString()); // Execute 60s early

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

        // Log early execution strategy
        await supabase.from('plan_logs').insert({
          plan_id: plan.id,
          msg: 'Scheduled run-plan 60s early to allow for cold start and session setup'
        });

        // Execute the plan by calling Railway worker
        const workerUrl = Deno.env.get("WORKER_BASE_URL");
        if (!workerUrl) {
          throw new Error("WORKER_BASE_URL not set");
        }

        let executionResult;
        let executionError;

        try {
          const resp = await fetch(`${workerUrl}/run-plan`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${Deno.env.get("SB_SERVICE_ROLE_KEY")!}`
            },
            body: JSON.stringify({ plan_id: plan.id })
          });

          executionResult = await resp.json();
          
          if (!resp.ok) {
            executionError = new Error(`HTTP ${resp.status}: ${resp.statusText}`);
          }
        } catch (error) {
          executionError = error;
        }

        if (executionError) {
          console.error(`Failed to execute plan ${plan.id}:`, executionError);
          
          // Extract detailed error information from the improved error response
          let errorDetails = executionError.message;
          if (executionError.context?.body) {
            try {
              const errorBody = typeof executionError.context.body === 'string' 
                ? JSON.parse(executionError.context.body) 
                : executionError.context.body;
              
              if (errorBody.code && errorBody.msg) {
                errorDetails = `${errorBody.code}: ${errorBody.msg}`;
                if (errorBody.details) {
                  console.log(`Plan ${plan.id} error details:`, errorBody.details);
                }
              }
            } catch (parseError) {
              console.log(`Could not parse error body for plan ${plan.id}:`, executionError.context.body);
            }
          }
          
          // Update status back to failed if execution failed
          await supabase
            .from('plans')
            .update({ status: 'failed' })
            .eq('id', plan.id);

          await supabase.from('plan_logs').insert({
            plan_id: plan.id,
            msg: `Scheduled execution failed: ${errorDetails}`
          });

          results.push({ 
            planId: plan.id, 
            success: false, 
            error: errorDetails 
          });
        } else if (executionResult && !executionResult.ok) {
          // Handle structured error responses that don't throw but return ok: false
          const errorDetails = executionResult.code 
            ? `${executionResult.code}: ${executionResult.msg}` 
            : executionResult.msg || 'Unknown execution error';
          
          console.error(`Plan ${plan.id} execution returned error:`, executionResult);
          
          await supabase
            .from('plans')
            .update({ status: 'failed' })
            .eq('id', plan.id);

          await supabase.from('plan_logs').insert({
            plan_id: plan.id,
            msg: `Scheduled execution failed: ${errorDetails}`
          });

          results.push({ 
            planId: plan.id, 
            success: false, 
            error: errorDetails 
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