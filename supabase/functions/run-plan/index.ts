import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// Structured JSON response helper
function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ===== ENVIRONMENT VALIDATION =====
    const requiredEnvVars = [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'WORKER_BASE_URL'
    ];
    
    const missingEnvVars = requiredEnvVars.filter(varName => !Deno.env.get(varName));
    if (missingEnvVars.length > 0) {
      console.error('Missing environment variables:', missingEnvVars);
      return jsonResponse({ 
        ok: false, 
        code: 'MISSING_ENV', 
        msg: `Missing environment variables: ${missingEnvVars.join(', ')}`,
        details: { missingVars: missingEnvVars }
      }, 500);
    }

    const workerBaseUrl = Deno.env.get('WORKER_BASE_URL');
    if (!workerBaseUrl) {
      return jsonResponse({
        ok: false,
        code: 'MISSING_WORKER_URL',
        msg: 'WORKER_BASE_URL environment variable is required'
      }, 500);
    }

    // ===== INPUT VALIDATION =====
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return jsonResponse({ 
        ok: false, 
        code: 'MISSING_AUTH', 
        msg: 'Authorization header required' 
      }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const { plan_id } = body;

    if (!plan_id) {
      return jsonResponse({ 
        ok: false, 
        code: 'MISSING_PLAN_ID', 
        msg: 'plan_id is required in request body' 
      }, 400);
    }

    console.log(`Edge function: Proxying plan execution request for plan_id: ${plan_id}`);

    // ===== FORWARD TO RAILWAY WORKER =====
    const workerUrl = `${workerBaseUrl}/run-plan`;
    
    const workerResponse = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
      },
      body: JSON.stringify({ plan_id })
    });

    if (!workerResponse.ok) {
      const errorText = await workerResponse.text().catch(() => 'Unknown error');
      console.error(`Worker request failed: ${workerResponse.status} ${errorText}`);
      
      return jsonResponse({
        ok: false,
        code: 'WORKER_REQUEST_FAILED',
        msg: `Worker request failed: ${workerResponse.status}`,
        details: { status: workerResponse.status, error: errorText }
      }, 502);
    }

    const workerData = await workerResponse.json();
    
    return jsonResponse({
      ok: true,
      msg: 'Plan execution started on worker',
      ...workerData
    });

  } catch (error: any) {
    console.error("Edge function handler error:", error);
    return jsonResponse({ 
      ok: false, 
      code: 'HANDLER_ERROR', 
      msg: error.message 
    }, 500);
  }
});