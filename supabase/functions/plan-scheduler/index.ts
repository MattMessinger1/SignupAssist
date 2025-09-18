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

    // Constants
    const SEED_LEAD_MINUTES = 10; // Seeding starts 10 minutes before open_time

    // Find plans ready for seeding (10-15 minutes before signup time)
    const now = new Date();
    const lateWindow = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago
    const seedingTime = new Date(now.getTime() + (SEED_LEAD_MINUTES * 60 * 1000)); // 10 minutes from now
    const seedingEndTime = new Date(now.getTime() + ((SEED_LEAD_MINUTES + 5) * 60 * 1000)); // 15 minutes from now (5 min window)

    // Find plans ready for seeding
    const { data: plansToSeed, error: seedFetchError } = await supabase
      .from('plans')
      .select('*')
      .eq('status', 'scheduled') // Only get scheduled plans
      .gte('open_time', seedingTime.toISOString()) // Plans opening in 10+ minutes
      .lte('open_time', seedingEndTime.toISOString()); // Plans opening in 10-15 minutes

    // Find plans ready for execution 
    // Execute plans that either:
    // 1. Are within 10 minutes of open time (to catch plans that missed seeding), OR
    // 2. Are within 60 seconds to 5 minutes after open time (normal execution window)
    const earlyExecutionTime = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes from now
    const normalExecutionTime = new Date(now.getTime() + 60 * 1000); // 60 seconds from now

    const { data: plansToExecute, error: fetchError } = await supabase
      .from('plans')
      .select('*')
      .eq('status', 'scheduled') // Only get scheduled plans (not cancelled, executed, etc.)
      .gte('open_time', lateWindow.toISOString()) // Not more than 5 minutes late
      .lte('open_time', earlyExecutionTime.toISOString()); // Execute up to 10 minutes early

    if (seedFetchError || fetchError) {
      console.error('Error fetching plans:', seedFetchError || fetchError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch plans' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Found ${plansToSeed?.length || 0} plans ready for seeding`);
    console.log(`Found ${plansToExecute?.length || 0} plans ready for execution`);

    let seedingCount = 0;
    let executedCount = 0;
    const results = [];

    // Process seeding plans first
    if (plansToSeed && plansToSeed.length > 0) {
      for (const plan of plansToSeed) {
        try {
          console.log(`Seeding plan ${plan.id} for ${plan.child_name} at ${plan.org}`);

          // Log seeding schedule
          await supabase.from('plan_logs').insert({
            plan_id: plan.id,
            msg: 'Scheduled seeding at T-10'
          });

          // Execute seeding by calling Railway worker
          const workerUrl = Deno.env.get("WORKER_BASE_URL");
          if (!workerUrl) {
            throw new Error("WORKER_BASE_URL not set");
          }

          const resp = await fetch(`${workerUrl}/seed-plan`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${Deno.env.get("SB_SERVICE_ROLE_KEY")!}`
            },
            body: JSON.stringify({ plan_id: plan.id })
          });

          if (!resp.ok) {
            console.error(`Seeding worker call failed for plan ${plan.id}: ${resp.status} ${resp.statusText}`);
            // Don't fail the plan, just log the error - seeding is non-critical
            await supabase.from('plan_logs').insert({
              plan_id: plan.id,
              msg: `Seeding failed but plan continues: ${resp.status} ${resp.statusText}`
            });
          } else {
            const seedingResult = await resp.json();
            console.log(`Seeding response for plan ${plan.id}:`, seedingResult);
            seedingCount++;
          }

          results.push({ 
            planId: plan.id, 
            success: true,
            action: 'seeded',
            child_name: plan.child_name,
            org: plan.org
          });

        } catch (error) {
          console.error(`Error seeding plan ${plan.id}:`, error);
          
          await supabase.from('plan_logs').insert({
            plan_id: plan.id,
            msg: `Seeding error (non-critical): ${error.message}`
          });

          results.push({ 
            planId: plan.id, 
            success: false,
            action: 'seeded', 
            error: error.message 
          });
        }
      }
    }

    // Process execution plans
    if (plansToExecute && plansToExecute.length > 0) {
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
            results.push({ planId: plan.id, success: false, action: 'executed', error: 'Status update failed' });
            continue;
          }

          // Log execution start
          await supabase.from('plan_logs').insert({
            plan_id: plan.id,
            msg: 'Automated execution started by scheduler'
          });

          // Log execution schedule
          await supabase.from('plan_logs').insert({
            plan_id: plan.id,
            msg: 'Scheduled execution at T=0'
          });

          // Execute the plan by calling Railway worker
          const workerUrl = Deno.env.get("WORKER_BASE_URL");
          if (!workerUrl) {
            throw new Error("WORKER_BASE_URL not set");
          }

          const resp = await fetch(`${workerUrl}/run-plan`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${Deno.env.get("SB_SERVICE_ROLE_KEY")!}`
            },
            body: JSON.stringify({ plan_id: plan.id })
          });

          if (!resp.ok) {
            throw new Error(`Worker call failed: ${resp.status} ${resp.statusText}`);
          }

          const executionResult = await resp.json();
          console.log(`Worker response for plan ${plan.id}:`, executionResult);

          console.log(`Successfully executed plan ${plan.id}`);
          executedCount++;
          results.push({ 
            planId: plan.id, 
            success: true,
            action: 'executed',
            child_name: plan.child_name,
            org: plan.org
          });

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
            action: 'executed', 
            error: error.message 
          });
        }
      }
    }

    if ((plansToSeed?.length || 0) === 0 && (plansToExecute?.length || 0) === 0) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: 'No plans ready for seeding or execution',
          seedingCount: 0,
          executedCount: 0 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Scheduler completed: ${seedingCount} seeded, ${executedCount}/${plansToExecute?.length || 0} executed successfully`);

    return new Response(
      JSON.stringify({ 
        success: true,
        seedingCount,
        executedCount,
        totalSeedPlans: plansToSeed?.length || 0,
        totalExecutePlans: plansToExecute?.length || 0,
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