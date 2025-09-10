import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { chromium } from "https://esm.sh/playwright-core@1.46.0";

// ===== POLICY CONSTANTS =====
const CAPTCHA_AUTOSOLVE_ENABLED = false; // NEVER call a CAPTCHA solver - SMS + verify link only
const PER_USER_WEEKLY_LIMIT = 3; // Maximum plans per user per 7 days  
const SMS_IMMEDIATE_ON_ACTION_REQUIRED = true; // Send SMS immediately when action required

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
    // ===== UPFRONT ENVIRONMENT VALIDATION =====
    const requiredEnvVars = [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY', 
      'BROWSERBASE_API_KEY',
      'BROWSERBASE_PROJECT_ID',
      'CRED_ENC_KEY'
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

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const authHeader = req.headers.get('Authorization');
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

    console.log(`Starting plan execution for plan_id: ${plan_id}`);

    // Log the start of the attempt
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Attempt started - loading plan details...'
    });

    // Check if this is a service role call (from scheduler) or user call
    const token = authHeader.replace('Bearer ', '');
    const isServiceRole = token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    
    let plan;
    let planError;
    
    if (isServiceRole) {
      // Service role call from scheduler - no user auth needed
      console.log('Service role call detected - fetching plan without user restriction');
      const { data, error } = await supabase
        .from('plans')
        .select('*')
        .eq('id', plan_id)
        .maybeSingle();
      plan = data;
      planError = error;
    } else {
      // Regular user call - authenticate user first
      const { data: { user } } = await supabase.auth.getUser(token);
      if (!user) {
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: 'Error: Authentication failed'
        });
        return jsonResponse({ 
          ok: false, 
          code: 'AUTH_FAILED', 
          msg: 'User authentication failed - invalid token' 
        }, 401);
      }

      const { data, error } = await supabase
        .from('plans')
        .select('*')
        .eq('id', plan_id)
        .eq('user_id', user.id)
        .maybeSingle();
      plan = data;
      planError = error;
    }

    if (planError || !plan) {
      const errorMsg = 'Plan not found or access denied';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Error: ${errorMsg}`
      });
      
      return jsonResponse({ 
        ok: false, 
        code: 'PLAN_NOT_FOUND', 
        msg: errorMsg,
        details: { plan_id, planError: planError?.message }
      }, 404);
    }

    // ===== SINGLE-EXECUTION POLICY =====
    // Only execute plans with status 'scheduled', 'action_required', or 'executing'
    if (plan.status !== 'scheduled' && plan.status !== 'action_required' && plan.status !== 'executing') {
      console.log(`Ignoring execution request for plan ${plan_id} with status '${plan.status}' - only 'scheduled', 'action_required', or 'executing' plans can be executed`);
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Execution ignored - plan status is '${plan.status}' (cannot execute ${plan.status === 'cancelled' ? 'cancelled' : plan.status} plans)`
      });
      
      return jsonResponse({ 
        ok: false, 
        code: 'INVALID_PLAN_STATUS', 
        msg: `Plan execution ignored - status is '${plan.status}'`,
        details: { 
          current_status: plan.status, 
          allowed_statuses: ['scheduled', 'action_required', 'executing'] 
        }
      }, 200);
    }

    // Log plan details found
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Plan loaded: ${plan.child_name} at ${plan.org} - proceeding with execution`
    });

    // Handle credential retrieval based on call type
    let credentials;
    if (isServiceRole) {
      // Service role call - decrypt credentials directly
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: 'Retrieving account credentials...'
      });

      // Get encrypted credential directly using service role
      const { data: credentialData, error: credError } = await supabase
        .from('account_credentials')
        .select('id, user_id, alias, provider_slug, email_enc, password_enc, cvv_enc')
        .eq('id', plan.credential_id)
        .eq('user_id', plan.user_id)
        .single();

      if (credError || !credentialData) {
        const errorMsg = 'Failed to retrieve credentials';
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Error: ${errorMsg}`
        });
        
        return jsonResponse({ 
          ok: false, 
          code: 'CREDENTIALS_NOT_FOUND', 
          msg: errorMsg,
          details: { credential_id: plan.credential_id, credError: credError?.message }
        }, 404);
      }

      // Decrypt credentials using the encryption key
      const CRED_ENC_KEY = Deno.env.get('CRED_ENC_KEY');
      if (!CRED_ENC_KEY) {
        const errorMsg = 'Encryption key not configured';
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Error: ${errorMsg}`
        });
        
        return jsonResponse({ 
          ok: false, 
          code: 'MISSING_ENCRYPTION_KEY', 
          msg: errorMsg 
        }, 500);
      }

      // Decrypt function (matching cred-store implementation)
      async function decrypt(encryptedString: string): Promise<string> {
        // Parse the JSON string to get the encrypted data object
        const encryptedData = JSON.parse(encryptedString);
        
        // Decode base64 key to bytes (matching cred-store)
        const keyBytes = Uint8Array.from(atob(CRED_ENC_KEY), c => c.charCodeAt(0));
        
        const key = await crypto.subtle.importKey(
          'raw',
          keyBytes,
          { name: 'AES-GCM' },
          false,
          ['decrypt']
        );

        const iv = new Uint8Array(encryptedData.iv);
        const ct = new Uint8Array(encryptedData.ct);

        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv },
          key,
          ct
        );

        const decoder = new TextDecoder();
        return decoder.decode(decrypted);
      }

      try {
        const email = await decrypt(credentialData.email_enc);
        const password = await decrypt(credentialData.password_enc);
        const cvv = credentialData.cvv_enc ? await decrypt(credentialData.cvv_enc) : null;

        credentials = {
          alias: credentialData.alias,
          email,
          password,
          cvv
        };
      } catch (decryptError) {
        const errorMsg = 'Failed to decrypt credentials';
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Error: ${errorMsg}`
        });
        
        return jsonResponse({ 
          ok: false, 
          code: 'DECRYPTION_FAILED', 
          msg: errorMsg,
          details: { error: decryptError.message }
        }, 500);
      }
    } else {
      // Regular user call - use cred-get function
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
        
        return jsonResponse({ 
          ok: false, 
          code: 'CRED_GET_FAILED', 
          msg: errorMsg,
          details: { credError: credError?.message }
        }, 404);
      }

      credentials = credentialResponse.data;
    }
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Using account: ${credentials.alias} (${credentials.email})`
    });

    // Create Browserbase session and connect Playwright
    const browserbaseApiKey = Deno.env.get("BROWSERBASE_API_KEY")!;
    const browserbaseProjectId = Deno.env.get("BROWSERBASE_PROJECT_ID")!;
    const sessionResp = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: { "X-BB-API-Key": browserbaseApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: browserbaseProjectId })
    });
    if (!sessionResp.ok) {
      const t = await sessionResp.text().catch(()=>"");
      console.error("Session create failed:", sessionResp.status, sessionResp.statusText, t);
      await supabase.from("plan_logs").insert({ plan_id, msg: `Error: Browserbase session failed ${sessionResp.status}` });
      return jsonResponse({ ok:false, code:"BROWSERBASE_SESSION_FAILED", msg:"Cannot create browser session" }, 500);
    }
    const session = await sessionResp.json();
    console.log("Browserbase session created:", session);
    await supabase.from("plan_logs").insert({ plan_id, msg: `✅ Browserbase session created: ${session.id}` });

    // Connect Playwright over CDP
    let browser: any = null;
    let page: any = null;
    try {
      browser = await chromium.connectOverCDP(session.connectUrl);
      const ctx = browser.contexts()[0] ?? await browser.newContext();
      page = ctx.pages()[0] ?? await ctx.newPage();
      console.log("Connected Playwright to session:", session.id);
      await supabase.from("plan_logs").insert({ plan_id, msg: "Playwright connected to Browserbase" });
    } catch (e) {
      console.error("Playwright connect error:", e);
      await supabase.from("plan_logs").insert({ plan_id, msg: `Error: Playwright connect error ${e?.message||e}` });
      return jsonResponse({ ok:false, code:"PLAYWRIGHT_CONNECT_FAILED", msg:"Cannot connect Playwright" }, 500);
    }

    // Compute login URL from plan
    const subdomain = (plan.org || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const loginUrl = `https://${subdomain}.skiclubpro.team/user/login`;
    
    // Perform login with Playwright
    await supabase.from("plan_logs").insert({ plan_id, msg: `Navigating to login: ${loginUrl}` });
    const loginResult = await loginWithPlaywright(page, loginUrl, credentials.email, credentials.password);
    if (!loginResult.success) {
      await supabase.from("plan_logs").insert({ plan_id, msg: `Login failed: ${loginResult.error}` });
      return jsonResponse({ ok:false, code:"LOGIN_FAILED", msg: loginResult.error }, 400);
    }
    await supabase.from("plan_logs").insert({ plan_id, msg: "Login successful" });

    // Perform discovery
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Starting discovery on: ${plan.base_url}`
    });

    try {
      const discoveryResult = await performDiscovery(session.id, browserbaseApiKey, plan.base_url);
      
      if (discoveryResult.success && discoveryResult.url) {
        // Store discovered URL in plans table
        await supabase.from('plans')
          .update({ discovered_url: discoveryResult.url })
          .eq('id', plan_id);

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
    console.log("Closing Browserbase session:", session.id);
    await fetch(`https://api.browserbase.com/v1/sessions/${session.id}`, {
      method: 'DELETE',
      headers: {
        'X-BB-API-Key': browserbaseApiKey,
      }
    });

    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `🛑 Browserbase session closed: ${session.id}`
    });

    console.log(`Plan execution completed for plan_id: ${plan_id}`);

    return jsonResponse({ 
      ok: true, 
      success: true, 
      msg: 'Plan execution completed successfully',
      data: { plan_id }
    }, 200);

  } catch (error) {
    console.error('Error in run-plan function:', error);
    
    return jsonResponse({ 
      ok: false, 
      code: 'UNEXPECTED_ERROR', 
      msg: 'Internal server error',
      details: { 
        error: error.message, 
        stack: error.stack,
        name: error.name 
      }
    }, 500);
  }
});

// Helper function for Playwright-based login
async function loginWithPlaywright(page: any, loginUrl: string, email: string, password: string) {
  console.log("Navigating to login URL:", loginUrl);
  await page.goto(loginUrl, { waitUntil: "networkidle" });
  // Wait for email input to appear (adjust if site differs)
  await page.waitForSelector('input[type="email"], input[name*="email"], input[id*="email"]', { timeout: 15000 });
  await page.fill('input[type="email"], input[name*="email"], input[id*="email"]', email);
  await page.fill('input[type="password"], input[name*="password"], input[id*="password"]', password);

  await Promise.all([
    page.click('button[type="submit"], input[type="submit"], text=/login/i, text=/sign in/i'),
    page.waitForNavigation({ waitUntil: "domcontentloaded" })
  ]);

  const bodyText = (await page.textContent("body"))?.toLowerCase() || "";
  if (bodyText.includes("invalid") || bodyText.includes("incorrect") || bodyText.includes("error")) {
    return { success:false, error:"Login appears to have failed" };
  }
  return { success:true };
}

// Helper function to perform login
async function performLogin(sessionId: string, apiKey: string, loginUrl: string, email: string, password: string) {
  try {
    // Navigate to login page
    console.log("Navigating to login URL:", loginUrl);
    let navigateResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/navigate`, {
      method: 'POST',
      headers: {
        'X-BB-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: loginUrl })
    });

    if (!navigateResponse.ok) {
      console.warn("Primary navigate endpoint failed, trying fallback endpoint /goto");
      
      // Try fallback endpoint
      navigateResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/goto`, {
        method: 'POST',
        headers: {
          'X-BB-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: loginUrl })
      });

      if (!navigateResponse.ok) {
        const errorText = await navigateResponse.text().catch(() => '');
        console.error("Fallback navigation failed:", {
          status: navigateResponse.status,
          statusText: navigateResponse.statusText,
          body: errorText
        });
        return { success: false, error: `Failed to navigate: ${navigateResponse.status} ${navigateResponse.statusText}` };
      }
    }

    // Wait for page load
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Fill email field
    await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/type`, {
      method: 'POST',
      headers: {
        'X-BB-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        selector: 'input[type="email"], input[name*="email"], input[id*="email"]',
        text: email
      })
    });

    // Fill password field
    await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/type`, {
      method: 'POST',
      headers: {
        'X-BB-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        selector: 'input[type="password"], input[name*="password"], input[id*="password"]',
        text: password
      })
    });

    // Submit form
    await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/click`, {
      method: 'POST',
      headers: {
        'X-BB-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        selector: 'button[type="submit"], input[type="submit"], button:contains("Login"), button:contains("Sign In")'
      })
    });

    // Wait for login to process
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check if login was successful by looking for common error indicators
    const pageResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/content`, {
      method: 'GET',
      headers: {
        'X-BB-API-Key': apiKey,
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
    const navigateResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/navigate`, {
      method: 'POST',
      headers: {
        'X-BB-API-Key': apiKey,
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
      const contentResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/content`, {
        method: 'GET',
        headers: {
          'X-BB-API-Key': apiKey,
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