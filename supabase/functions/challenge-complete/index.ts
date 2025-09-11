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

    const { token, cvv } = await req.json();

    if (!token) {
      return new Response(
        JSON.stringify({ error: 'token is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing challenge completion for token: ${token}`);

    // Get challenge details
    const { data: challenge, error: challengeError } = await supabase
      .from('challenges')
      .select('*')
      .eq('token', token)
      .eq('status', 'pending')
      .maybeSingle();

    if (challengeError) {
      console.error('Error fetching challenge:', challengeError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch challenge' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!challenge) {
      return new Response(
        JSON.stringify({ error: 'Challenge not found or already completed' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if challenge has expired
    const now = new Date();
    const expiresAt = new Date(challenge.expires_at);
    
    if (now > expiresAt) {
      await supabase
        .from('challenges')
        .update({ status: 'expired' })
        .eq('token', token);

      return new Response(
        JSON.stringify({ error: 'Challenge has expired' }),
        { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Prepare update data
    const updateData: any = {
      status: 'resolved',
      data: challenge.data || {}
    };

    // Handle CVV if provided and it's a CVV challenge
    if (challenge.type === 'cvv' && cvv) {
      // Simple encryption (in production, use proper encryption)
      const encryptedCvv = btoa(cvv); // Base64 encoding (use real encryption in production)
      updateData.data = {
        ...updateData.data,
        encrypted_cvv: encryptedCvv
      };
      console.log(`CVV provided for challenge ${token}`);
    }

    // Update challenge status
    const { error: updateError } = await supabase
      .from('challenges')
      .update(updateData)
      .eq('token', token);

    if (updateError) {
      console.error('Error updating challenge:', updateError);
      return new Response(
        JSON.stringify({ error: 'Failed to update challenge' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Log completion
    await supabase.from('plan_logs').insert({
      plan_id: challenge.plan_id,
      msg: `Challenge ${challenge.type} resolved via token ${token}${cvv ? ' (CVV provided)' : ''}`
    });

    console.log(`Challenge ${token} completed successfully`);

    // If this is a CVV challenge with CVV provided, trigger resume of execution
    if (challenge.type === 'cvv' && cvv) {
      // In a real implementation, you might trigger a webhook or background task
      // to resume the execute-plan process here
      console.log(`Triggering resume for plan ${challenge.plan_id}`);
      
      // For now, just log that resume should happen
      await supabase.from('plan_logs').insert({
        plan_id: challenge.plan_id,
        msg: 'CVV challenge resolved - execution can resume'
      });
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        challenge_type: challenge.type,
        plan_id: challenge.plan_id,
        message: challenge.type === 'cvv' ? 'CVV received - finishing up...' : 'Challenge completed - continuing...'
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in challenge-complete function:', error);
    
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});