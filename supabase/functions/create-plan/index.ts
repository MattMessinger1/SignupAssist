import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

// ===== POLICY CONSTANTS =====
const CAPTCHA_AUTOSOLVE_ENABLED = false; // NEVER call a CAPTCHA solver
const PER_USER_WEEKLY_LIMIT = 100; // Maximum plans per user per 7 days (increased for testing)
const SMS_IMMEDIATE_ON_ACTION_REQUIRED = true; // Send SMS immediately when action required

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

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Authorization required' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Authentication failed' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const requestData = await req.json();
    console.log('Plan creation request:', { userId: user.id, ...requestData });

    // ===== RATE LIMITING CHECK =====
    // Count user's plans created in the last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const { data: recentPlans, error: countError } = await supabase
      .from('plans')
      .select('id')
      .eq('user_id', user.id)
      .gte('created_at', sevenDaysAgo.toISOString());

    if (countError) {
      console.error('Error checking plan count:', countError);
      return new Response(
        JSON.stringify({ error: 'Rate limit check failed' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const planCount = recentPlans?.length || 0;
    console.log(`User ${user.id} has created ${planCount} plans in the last 7 days`);

    if (planCount >= PER_USER_WEEKLY_LIMIT) {
      console.log(`Rate limit exceeded for user ${user.id}: ${planCount}/${PER_USER_WEEKLY_LIMIT}`);
      return new Response(
        JSON.stringify({ 
          error: `You've reached the ${PER_USER_WEEKLY_LIMIT} signups/week limit.`,
          rate_limit_exceeded: true
        }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ===== PLAN CREATION =====
    const planData = {
      user_id: user.id,
      provider_slug: requestData.provider_slug || 'skiclubpro',
      org: requestData.org,
      base_url: requestData.base_url,
      child_name: requestData.child_name,
      open_time: requestData.open_time,
      preferred: requestData.preferred,
      alternate: requestData.alternate || null,
      preferred_class_name: requestData.preferred_class_name || null,
      alternate_class_name: requestData.alternate_class_name || null,
      credential_id: requestData.credential_id,
      phone: requestData.phone || null,
      status: 'scheduled',
      paid: false,
      extras: requestData.extras || null
    };

    const { data: plan, error: insertError } = await supabase
      .from('plans')
      .insert(planData)
      .select()
      .single();

    if (insertError) {
      console.error('Error creating plan:', insertError);
      return new Response(
        JSON.stringify({ error: 'Failed to create plan' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Plan created successfully:', plan.id);

    return new Response(
      JSON.stringify({ 
        success: true, 
        plan: plan,
        rate_limit_status: {
          used: planCount + 1,
          limit: PER_USER_WEEKLY_LIMIT,
          remaining: Math.max(0, PER_USER_WEEKLY_LIMIT - planCount - 1)
        }
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in create-plan function:', error);
    
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});