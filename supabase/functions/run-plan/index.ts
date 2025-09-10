import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { chromium } from "https://esm.sh/playwright-core@1.46.0";

// ===== POLICY CONSTANTS =====
const CAPTCHA_AUTOSOLVE_ENABLED = false; // NEVER call a CAPTCHA solver - SMS + verify link only
const PER_USER_WEEKLY_LIMIT = 3; // Maximum plans per user per 7 days  
const SMS_IMMEDIATE_ON_ACTION_REQUIRED = true; // Send SMS immediately when action required

// Debug logging helper - set DEBUG_VERBOSE=1 in Supabase function secrets to enable verbose logs
const DEBUG_VERBOSE = Deno.env.get("DEBUG_VERBOSE") === "1";
function dlog(...args: any[]) { 
  if (DEBUG_VERBOSE) console.log(...args); 
}

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
      dlog('Service role call detected - fetching plan without user restriction');
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

    // ===== RESOLVE EXTRAS / AUTOS =====
    const EXTRAS = (plan?.extras ?? {}) as any;

    // Support both extras.* and top-level fallback (back-compat)
    function isAuto(v: any) {
      return v === null || v === undefined || v === '' || String(v).trim() === '__AUTO__';
    }

    const nordicRental = isAuto(EXTRAS.nordicRental) ? null : (EXTRAS.nordicRental ?? null);
    const nordicColorGroupRaw = (EXTRAS.nordicColorGroup ?? null);
    const volunteerRaw = (EXTRAS.volunteer ?? null);
    const allowNoCvv =
      (EXTRAS.allow_no_cvv === true || EXTRAS.allow_no_cvv === 'true' || plan.allow_no_cvv === true);

    // Normalize autos
    const nordicColorGroup = isAuto(nordicColorGroupRaw) ? null : nordicColorGroupRaw;
    const volunteer = isAuto(volunteerRaw) ? null : volunteerRaw;

    // Create Browserbase session and connect Playwright
    const browserbaseApiKey = Deno.env.get("BROWSERBASE_API_KEY")!;
    const browserbaseProjectId = Deno.env.get("BROWSERBASE_PROJECT_ID")!;
    
    let session: any = null;
    let browser: any = null;
    
    try {
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
      session = await sessionResp.json();
      dlog("Browserbase session created:", session);
      await supabase.from("plan_logs").insert({ plan_id, msg: `✅ Browserbase session created: ${session.id}` });

      // Connect Playwright over CDP
      let page: any = null;
      try {
        browser = await chromium.connectOverCDP(session.connectUrl);
        const ctx = browser.contexts()[0] ?? await browser.newContext();
        page = ctx.pages()[0] ?? await ctx.newPage();
        dlog("Connected Playwright to session:", session.id);
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

      //// ===== PAYMENT READINESS GATE =====
      await supabase.from('plan_logs').insert({ plan_id, msg: 'Checking payment readiness…' });

      // We handle saved-card + CVV flows; allow override if site never asks for CVV.
      const hasCVV = !!(credentials?.cvv && String(credentials.cvv).trim().length > 0);
      if (!allowNoCvv && !hasCVV) {
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: 'Payment not ready: saved card CVV required or set extras.allow_no_cvv=true'
        });
        return jsonResponse({
          ok: false,
          code: 'PAYMENT_NOT_READY',
          msg: 'Saved card CVV required (or set extras.allow_no_cvv=true if checkout never requests CVV).'
        }, 422);
      }

      // Optional probe: if full card fields appear, we can't proceed (we don't collect PAN)
      try {
        const origin = plan.base_url ? new URL(plan.base_url) : new URL(`https://${subdomain}.skiclubpro.team/`);
        const cartUrl = new URL('/cart', origin).toString();
        await page.goto(cartUrl, { waitUntil: 'domcontentloaded' });
        const probe = (await page.content()).toLowerCase();
        const fullCard = /(card number|cardnumber|name on card|expiration|exp month|exp year)/i.test(probe);
        if (fullCard && !allowNoCvv) {
          await supabase.from('plan_logs').insert({
            plan_id,
            msg: 'Detected full-card fields; saved card required. Aborting.'
          });
          return jsonResponse({
            ok: false,
            code: 'PAYMENT_NOT_READY',
            msg: 'Checkout requires full card entry. Save a card on your SkiClubPro account first.'
          }, 422);
        }
      } catch { /* non-fatal */ }

      // Navigate to target page
      const targetUrl = plan.discovered_url || plan.base_url || `https://${subdomain}.skiclubpro.team/dashboard`;
      await supabase.from("plan_logs").insert({ plan_id, msg: `Opening target page: ${targetUrl}` });
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

      // If no discovered URL, run discovery with Playwright
      if (!plan.discovered_url) {
        await supabase.from("plan_logs").insert({ plan_id, msg: "Starting discovery..." });
        
        try {
          const discoveryResult = await performPlaywrightDiscovery(page, plan.base_url);
          
          if (discoveryResult.success && discoveryResult.url) {
            // Store discovered URL in plans table
            await supabase.from('plans')
              .update({ discovered_url: discoveryResult.url })
              .eq('id', plan_id);

            // Navigate to discovered page
            await page.goto(discoveryResult.url, { waitUntil: "domcontentloaded" });
            await supabase.from("plan_logs").insert({ plan_id, msg: `Discovered URL: ${discoveryResult.url}` });
          } else {
            await supabase.from("plan_logs").insert({ plan_id, msg: "Discovery completed - no signup links found" });
          }
        } catch (error) {
          await supabase.from("plan_logs").insert({ plan_id, msg: `Discovery error: ${error.message}` });
        }
      }

      // Slot selection
      await supabase.from("plan_logs").insert({ plan_id, msg: `Selecting slot. Preferred: "${plan.preferred}"${plan.alternate?`, Alt: "${plan.alternate}"`:``}` });
      const used = await clickByTexts(page, [plan.preferred, plan.alternate].filter(Boolean));
      if (!used) { 
        await supabase.from("plan_logs").insert({ plan_id, msg: "No preferred/alternate slot found" });
        return jsonResponse({ ok:false, code:"SLOT_NOT_FOUND", msg:"Could not find slot" }, 404);
      }
      await supabase.from("plan_logs").insert({ plan_id, msg: `Selected slot: ${used}` });

      // Child selection (if applicable)
      if (plan.child_name) {
        await supabase.from("plan_logs").insert({ plan_id, msg: `Choosing child: ${plan.child_name}` });
        const picked = await clickByTexts(page, [plan.child_name]);
        if (!picked) {
          await supabase.from("plan_logs").insert({ plan_id, msg: "Child selector not found (continuing)" });
        }
      }

      // ===== NORDIC ADD-ONS (if present) =====
      try {
        await handleNordicAddons(page, plan_id, supabase, {
          nordicRental,
          nordicColorGroup,
          volunteer
        });
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg === 'RENTAL_REQUIRED') {
          return jsonResponse({ ok:false, code:'RENTAL_REQUIRED', msg:'Rental option required for Nordic. Add extras.nordicRental to your plan.' }, 422);
        }
        if (msg === 'RENTAL_NOT_FOUND') {
          return jsonResponse({ ok:false, code:'RENTAL_NOT_FOUND', msg:`Rental option not found on page: ${nordicRental}` }, 404);
        }
        await supabase.from('plan_logs').insert({ plan_id, msg: `Add-ons error: ${msg}` });
      }

      // Add to cart / register
      await supabase.from("plan_logs").insert({ plan_id, msg: "Clicking Add/Register/Cart..." });
      await clickByTexts(page, ["Add to cart","Add","Enroll","Register","Cart","Continue"]);

      // Verify cart contains the chosen text
      const verifyText = used || plan.preferred;
      const cartHtml = (await page.content()).toLowerCase();
      if (!cartHtml.includes((verifyText||"").toLowerCase())) {
        await supabase.from("plan_logs").insert({ plan_id, msg: "Cart verify failed" });
        return jsonResponse({ ok:false, code:"VERIFY_FAILED", msg:"Item not visible in cart/summary" }, 422);
      }
      await supabase.from("plan_logs").insert({ plan_id, msg: `Verified cart contains: ${verifyText}` });

      // Proceed to checkout
      await supabase.from("plan_logs").insert({ plan_id, msg: "Proceeding to checkout..." });
      await clickByTexts(page, ["Checkout","Continue","Next"]);

      // Handle CVV if requested
      const afterCheckout = (await page.content()).toLowerCase();
      const cvvNeeded = /cvv|cvc|security code/.test(afterCheckout);
      if (cvvNeeded) {
        await supabase.from("plan_logs").insert({ plan_id, msg: "CVV required at checkout" });
        if (credentials.cvv) {
          // Try common CVV selectors
          const cvvSelectors = [
            'input[name*="cvv"]','input[id*="cvv"]','input[name*="cvc"]','input[id*="cvc"]','input[autocomplete="cc-csc"]'
          ];
          let filled = false;
          for (const sel of cvvSelectors) {
            try { await page.fill(sel, credentials.cvv); filled = true; break; } catch {}
          }
          if (filled) {
            await supabase.from("plan_logs").insert({ plan_id, msg: "CVV filled" });
            await clickByTexts(page, ["Pay","Submit","Finish","Complete"]);
          } else {
            await supabase.from("plan_logs").insert({ plan_id, msg: "CVV field not found" });
            return jsonResponse({ ok:false, code:"CVV_FIELD_NOT_FOUND", msg:"CVV field not found on page" }, 422);
          }
        } else {
          await supabase.from("plan_logs").insert({ plan_id, msg: "CVV needed from user – marking action_required" });
          return jsonResponse({ ok:true, success:false, code:"CVV_NEEDED", msg:"CVV required to complete payment" }, 200);
        }
      }

      // Confirm success
      const finalHtml = (await page.content()).toLowerCase();
      const success = /(thank you|confirmation|order complete|success)/.test(finalHtml);
      if (!success) {
        await supabase.from("plan_logs").insert({ plan_id, msg: "Sign-up not confirmed" });
        return jsonResponse({ ok:false, code:"SIGNUP_NOT_CONFIRMED", msg:"Could not confirm sign-up" }, 422);
      }
      await supabase.from("plan_logs").insert({ plan_id, msg: "🎉 Sign-up completed successfully!" });

      dlog(`Plan execution completed for plan_id: ${plan_id}`);
      
      return jsonResponse({ 
        ok: true, 
        success: true, 
        msg: 'Plan executed: sign-up complete',
        data: { plan_id }
      }, 200);

    } catch (e) {
      console.error("Error in run-plan:", e);
      await supabase.from("plan_logs").insert({ plan_id, msg: `Error: ${e?.message||e}` });
      return jsonResponse({ ok:false, code:"UNEXPECTED_ERROR", msg:"Internal server error" }, 500);
    } finally {
      try { await browser?.close(); } catch {}
      try {
        if (session?.id) {
          await fetch(`https://api.browserbase.com/v1/sessions/${session.id}`, {
            method: "DELETE", 
            headers: { "X-BB-API-Key": browserbaseApiKey }
          });
        }
      } catch {}
      if (session?.id) {
        await supabase.from("plan_logs").insert({ plan_id, msg: `🛑 Browserbase session closed: ${session.id}` });
      }
    }

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
  dlog("Navigating to login URL:", loginUrl);
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

// Helper function to perform discovery with Playwright
async function performPlaywrightDiscovery(page: any, baseUrl: string) {
  try {
    // Navigate to base URL if not already there
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    
    const targetTexts = ["Register", "Lessons", "Programs", "Class", "Enroll"];
    const maxTime = 45000; // 45 seconds
    const checkInterval = 2000; // 2 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxTime) {
      // Get page content
      const content = await page.content();
      
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

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    return { success: true, url: null }; // No links found within time limit
  } catch (error) {
    return { success: false, error: error.message };
  }
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

async function clickByTexts(page: any, texts: string[]) {
  for (const t of texts) {
    const locator = page.getByRole("button", { name: new RegExp(t, "i") });
    if (await locator.count().catch(() => 0)) {
      try { 
        await locator.first().click(); 
        return t; 
      } catch {}
    }
    // generic text selector fallback
    const alt = page.locator(`text=${t}`);
    if (await alt.count().catch(() => 0)) {
      try { 
        await alt.first().click(); 
        return t; 
      } catch {}
    }
  }
  return null;
}

async function handleNordicAddons(page: any, plan_id: string, supabase: any, opts: {
  nordicRental: string | null,
  nordicColorGroup: string | null,
  volunteer: string | null
}) {
  const html = (await page.content()).toLowerCase();
  const looksLikeForm = /nordic|registration|question|options/.test(html);
  if (!looksLikeForm) {
    await supabase.from('plan_logs').insert({ plan_id, msg: 'No Nordic add-on form detected (continuing)…' });
    return;
  }

  await supabase.from('plan_logs').insert({ plan_id, msg: 'Handling Nordic add-ons…' });

  // Helper: select first non-placeholder option
  async function selectFirstRealOption(selectLocator: string) {
    const exists = await page.locator(selectLocator).first().count();
    if (!exists) return false;
    const options = await page.locator(`${selectLocator} option`).allTextContents();
    const firstReal = options.find(t => t && !/^\s*-\s*select\s*-\s*$/i.test(t));
    if (!firstReal) return false;
    await page.selectOption(selectLocator, { label: firstReal });
    return true;
  }

  // RENTAL (paid): any <select> with $ in options → must be provided in opts.nordicRental
  const selects = page.locator('select');
  const n = await selects.count();
  for (let i = 0; i < n; i++) {
    const sel = selects.nth(i);
    const optsText = await sel.locator('option').allTextContents();
    const hasDollar = optsText.some(o => /\$\s*\d/.test(o));
    if (hasDollar) {
      if (!opts.nordicRental) {
        await supabase.from('plan_logs').insert({ plan_id, msg: 'Rental option required for Nordic but not in extras.' });
        throw new Error('RENTAL_REQUIRED');
      }
      let matched = false;
      try { await sel.selectOption({ label: opts.nordicRental }); matched = true; } catch {}
      if (!matched) {
        const match = optsText.find(o => o.toLowerCase().includes(opts.nordicRental!.toLowerCase()));
        if (match) { await sel.selectOption({ label: match }); matched = true; }
      }
      if (!matched) {
        await supabase.from('plan_logs').insert({ plan_id, msg: `Rental option not found: ${opts.nordicRental}` });
        throw new Error('RENTAL_NOT_FOUND');
      }
      await supabase.from('plan_logs').insert({ plan_id, msg: `Rental selected: ${opts.nordicRental}` });
    }
  }

  // COLOR GROUP (no $): use provided or default to first option
  if (opts.nordicColorGroup) {
    const candidates = ['select[name*="color"]', 'select[id*="color"]', 'select'];
    let done = false;
    for (const c of candidates) {
      try { await page.selectOption(c, { label: opts.nordicColorGroup }); done = true; break; } catch {}
    }
    if (done) {
      await supabase.from('plan_logs').insert({ plan_id, msg: `Color group: ${opts.nordicColorGroup}` });
    } else {
      await supabase.from('plan_logs').insert({ plan_id, msg: `Color group not found (${opts.nordicColorGroup}). Defaulting.` });
      await selectFirstRealOption('select');
    }
  } else {
    await selectFirstRealOption('select');
    await supabase.from('plan_logs').insert({ plan_id, msg: 'Color group defaulted to first option.' });
  }

  // VOLUNTEER (checkboxes, no $): pick provided label or first checkbox
  const cbs = page.locator('input[type="checkbox"]');
  if (await cbs.count()) {
    if (opts.volunteer) {
      const labeled = page.getByLabel(new RegExp(opts.volunteer, 'i'));
      if (await labeled.count()) {
        await labeled.first().check().catch(()=>{});
        await supabase.from('plan_logs').insert({ plan_id, msg: `Volunteer selected: ${opts.volunteer}` });
      } else {
        await cbs.first().check().catch(()=>{});
        await supabase.from('plan_logs').insert({ plan_id, msg: 'Volunteer defaulted (label not found).' });
      }
    } else {
      await cbs.first().check().catch(()=>{});
      await supabase.from('plan_logs').insert({ plan_id, msg: 'Volunteer defaulted to first option.' });
    }
  }

  // Skip donations if present
  const donation = page.locator('input[name*="donation"], input[id*="donation"]');
  if (await donation.count()) {
    try { await donation.first().fill('0'); } catch {}
    await supabase.from('plan_logs').insert({ plan_id, msg: 'Donation skipped (0).' });
  }

  // Proceed/Next if visible
  const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), input[type="submit"]');
  if (await nextBtn.count()) {
    await nextBtn.first().click().catch(()=>{});
    await supabase.from('plan_logs').insert({ plan_id, msg: 'Advanced past add-ons form.' });
    await page.waitForLoadState('domcontentloaded').catch(()=>{});
  }
}