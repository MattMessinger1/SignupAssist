import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface BrowserbaseSession {
  id: string;
  status: string;
}

interface BrowserbaseContext {
  id: string;
}

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

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Authorization required' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { plan_id } = await req.json();

    if (!plan_id) {
      return new Response(
        JSON.stringify({ error: 'plan_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Starting plan execution for plan_id: ${plan_id}`);

    // Log the start of the attempt
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Attempt started - loading plan details...'
    });

    // Get plan details with auth check
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!user) {
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: 'Error: Authentication failed'
      });
      return new Response(
        JSON.stringify({ error: 'Authentication failed' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('*')
      .eq('id', plan_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (planError || !plan) {
      const errorMsg = 'Plan not found or access denied';
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
      msg: `Plan loaded: ${plan.child_name} at ${plan.org}`
    });

    // Get decrypted credentials via cred-get
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Retrieving account credentials...'
    });

    const { data: credentialResponse, error: credError } = await supabase
      .functions
      .invoke('cred-get', {
        body: { credential_id: plan.credential_id },
        headers: { Authorization: authHeader }
      });

    if (credError || !credentialResponse?.success) {
      const errorMsg = 'Failed to retrieve credentials';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Error: ${errorMsg}`
      });
      
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const credentials = credentialResponse.data;
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Using account: ${credentials.alias} (${credentials.email})`
    });

    // Start Browserbase session
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Starting browser session...'
    });

    const browserbaseApiKey = Deno.env.get('BROWSERBASE_API_KEY');
    if (!browserbaseApiKey) {
      const errorMsg = 'Browserbase API key not configured';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Error: ${errorMsg}`
      });
      
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const browserbaseProjectId = Deno.env.get('BROWSERBASE_PROJECT_ID');
    if (!browserbaseProjectId) {
      const errorMsg = 'Browserbase project ID not configured';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Error: ${errorMsg}`
      });
      
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create Browserbase session
    const sessionResponse = await fetch('https://www.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${browserbaseApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: browserbaseProjectId
      })
    });

    if (!sessionResponse.ok) {
      const errorMsg = 'Failed to create browser session';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Error: ${errorMsg}`
      });
      
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const session: BrowserbaseSession = await sessionResponse.json();
    
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Browser session created: ${session.id}`
    });

    // Determine subdomain from org name
    const subdomain = plan.org.toLowerCase().replace(/[^a-z0-9]/g, '');
    const loginUrl = `https://${subdomain}.skiclubpro.team/user/login`;
    
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Navigating to login: ${loginUrl}`
    });

    // Perform login via Browserbase
    try {
      const loginResult = await performLogin(session.id, browserbaseApiKey, loginUrl, credentials.email, credentials.password);
      
      if (loginResult.success) {
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: 'Login successful'
        });
      } else {
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Login failed: ${loginResult.error}`
        });
        
        return new Response(
          JSON.stringify({ error: `Login failed: ${loginResult.error}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    } catch (error) {
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Login error: ${error.message}`
      });
      
      return new Response(
        JSON.stringify({ error: `Login error: ${error.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Perform discovery
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Starting discovery on: ${plan.base_url}`
    });

    try {
      const discoveryResult = await performDiscovery(session.id, browserbaseApiKey, plan.base_url);
      
      if (discoveryResult.success && discoveryResult.url) {
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Discovered URL: ${discoveryResult.url}`
        });
      } else {
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: 'Discovery completed - no signup links found'
        });
      }
    } catch (error) {
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Discovery error: ${error.message}`
      });
    }

    // Close browser session
    await fetch(`https://www.browserbase.com/v1/sessions/${session.id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${browserbaseApiKey}`,
      }
    });

    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Browser session closed - execution phase complete'
    });

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

// Helper function to perform login
async function performLogin(sessionId: string, apiKey: string, loginUrl: string, email: string, password: string) {
  try {
    // Navigate to login page
    const navigateResponse = await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/navigate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: loginUrl })
    });

    if (!navigateResponse.ok) {
      return { success: false, error: 'Failed to navigate to login page' };
    }

    // Wait for page load
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Fill email field
    await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/type`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        selector: 'input[type="email"], input[name*="email"], input[id*="email"]',
        text: email
      })
    });

    // Fill password field
    await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/type`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        selector: 'input[type="password"], input[name*="password"], input[id*="password"]',
        text: password
      })
    });

    // Submit form
    await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/click`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        selector: 'button[type="submit"], input[type="submit"], button:contains("Login"), button:contains("Sign In")'
      })
    });

    // Wait for login to process
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check if login was successful by looking for common error indicators
    const pageResponse = await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/content`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      }
    });

    if (pageResponse.ok) {
      const content = await pageResponse.text();
      if (content.toLowerCase().includes('error') || content.toLowerCase().includes('invalid') || 
          content.toLowerCase().includes('incorrect') || content.toLowerCase().includes('failed')) {
        return { success: false, error: 'Login credentials invalid or login failed' };
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Helper function to perform discovery
async function performDiscovery(sessionId: string, apiKey: string, baseUrl: string) {
  try {
    // Navigate to base URL
    const navigateResponse = await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/navigate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: baseUrl })
    });

    if (!navigateResponse.ok) {
      return { success: false, error: 'Failed to navigate to base URL' };
    }

    // Wait for page load
    await new Promise(resolve => setTimeout(resolve, 3000));

    const targetTexts = ["Register", "Lessons", "Programs", "Class", "Enroll"];
    const maxTime = 45000; // 45 seconds
    const checkInterval = 2000; // 2 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxTime) {
      // Get page content
      const contentResponse = await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/content`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        }
      });

      if (contentResponse.ok) {
        const content = await contentResponse.text();
        
        // Look for links containing target text
        for (const targetText of targetTexts) {
          const regex = new RegExp(`<a[^>]*href="([^"]*)"[^>]*>[^<]*${targetText}[^<]*</a>`, 'i');
          const match = content.match(regex);
          
          if (match) {
            let url = match[1];
            
            // Convert relative URL to absolute
            if (url.startsWith('/')) {
              const baseUrlObj = new URL(baseUrl);
              url = `${baseUrlObj.origin}${url}`;
            } else if (!url.startsWith('http')) {
              url = `${baseUrl}/${url}`;
            }
            
            return { success: true, url, text: targetText };
          }
        }
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    return { success: true, url: null }; // No links found within time limit
  } catch (error) {
    return { success: false, error: error.message };
  }
}