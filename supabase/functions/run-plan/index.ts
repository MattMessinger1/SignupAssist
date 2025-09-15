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

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

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

    console.log(`Edge function: Plan execution request for plan_id: ${plan_id}`);

    // Log the proxy request
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Edge function: Validating user and forwarding to worker...'
    });

    // Authenticate user (not service role calls)
    const token = authHeader.replace('Bearer ', '');
    const isServiceRole = token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    
    if (!isServiceRole) {
      // Regular user call - authenticate user first
      const { data: { user } } = await supabase.auth.getUser(token);
      if (!user) {
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: 'Edge function: Authentication failed'
        });
        return jsonResponse({ 
          ok: false, 
          code: 'AUTH_FAILED', 
          msg: 'User authentication failed - invalid token' 
        }, 401);
      }

      // Verify plan belongs to user
      const { data: plan, error: planError } = await supabase
        .from('plans')
        .select('id, user_id')
        .eq('id', plan_id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (planError || !plan) {
        const errorMsg = 'Plan not found or access denied';
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Edge function: ${errorMsg}`
        });
        
        return jsonResponse({ 
          ok: false, 
          code: 'PLAN_NOT_FOUND', 
          msg: errorMsg,
          details: { plan_id, planError: planError?.message }
        }, 404);
      }
    }

    // Forward to Railway worker with service role key
    const workerUrl = `${Deno.env.get('WORKER_BASE_URL')}/run-plan`;
    
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Edge function: Forwarding to worker at ${workerUrl}`
    });

    try {
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
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Edge function: Worker request failed: ${workerResponse.status} ${errorText}`
        });
        
        return jsonResponse({
          ok: false,
          code: 'WORKER_REQUEST_FAILED',
          msg: `Worker request failed: ${workerResponse.status}`,
          details: { status: workerResponse.status, error: errorText }
        }, 502);
      }

      const workerData = await workerResponse.json();
      
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: 'Edge function: Successfully forwarded to worker'
      });

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
        
        const response = jsonResponse({ 
          ok: false, 
          code: 'CREDENTIALS_NOT_FOUND', 
          msg: errorMsg,
          details: { credential_id: plan.credential_id, credError: credError?.message }
        }, 404);
        return res.status(response.statusCode).json(JSON.parse(response.body));
      }

      // Decrypt credentials using the encryption key
      const CRED_ENC_KEY = process.env.CRED_ENC_KEY;
      if (!CRED_ENC_KEY) {
        const errorMsg = 'Encryption key not configured';
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Error: ${errorMsg}`
        });
        
        const response = jsonResponse({ 
          ok: false, 
          code: 'MISSING_ENCRYPTION_KEY', 
          msg: errorMsg 
        }, 500);
        return res.status(response.statusCode).json(JSON.parse(response.body));
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
      } catch (decryptError: any) {
        const errorMsg = 'Failed to decrypt credentials';
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Error: ${errorMsg}`
        });
        
        const response = jsonResponse({ 
          ok: false, 
          code: 'DECRYPTION_FAILED', 
          msg: errorMsg,
          details: { error: decryptError.message }
        }, 500);
        return res.status(response.statusCode).json(JSON.parse(response.body));
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
        
        const response = jsonResponse({ 
          ok: false, 
          code: 'CRED_GET_FAILED', 
          msg: errorMsg,
          details: { credError: credError?.message }
        }, 404);
        return res.status(response.statusCode).json(JSON.parse(response.body));
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
    const browserbaseApiKey = process.env.BROWSERBASE_API_KEY!;
    const browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID!;
    
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
        const response = jsonResponse({ ok:false, code:"BROWSERBASE_SESSION_FAILED", msg:"Cannot create browser session" }, 500);
        return res.status(response.statusCode).json(JSON.parse(response.body));
      }
      session = await sessionResp.json();
      dlog("Browserbase session created:", session);
      await supabase.from("plan_logs").insert({ plan_id, msg: `✅ Browserbase session created: ${session.id}` });

      // Connect Playwright over CDP
      let page: any = null;
      try {
        await supabase.from("plan_logs").insert({
          plan_id,
          msg: "PLAYWRIGHT_CONNECT_START"
        });
        
        browser = await chromium.connectOverCDP(session.connectUrl);
        
        await supabase.from("plan_logs").insert({
          plan_id,
          msg: "PLAYWRIGHT_CONNECT_SUCCESS"
        });

        const ctx = browser.contexts()[0] ?? await browser.newContext();
        page = ctx.pages()[0] ?? await ctx.newPage();

        await supabase.from("plan_logs").insert({ plan_id, msg: "Playwright connected" });
        dlog("Connected Playwright to session:", session.id);
        await supabase.from("plan_logs").insert({ plan_id, msg: "Playwright connected to Browserbase" });
      } catch (e: any) {
        console.error("Playwright connect error:", e);
        await supabase.from("plan_logs").insert({
          plan_id,
          msg: "PLAYWRIGHT_CONNECT_FAILED: " + (e?.message ?? String(e))
        });
        const response = jsonResponse({ ok:false, code:"PLAYWRIGHT_CONNECT_FAILED", msg:"Cannot connect Playwright" }, 500);
        return res.status(response.statusCode).json(JSON.parse(response.body));
      }

      // Compute login URL from plan
      const subdomain = (plan.org || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const loginUrl = `https://${subdomain}.skiclubpro.team/user/login`;
      
      // Perform login with Playwright
      await supabase.from("plan_logs").insert({ plan_id, msg: `Navigating to login: ${loginUrl}` });
      const loginResult = await loginWithPlaywright(page, loginUrl, credentials.email, credentials.password);
      if (!loginResult.success) {
        await supabase.from("plan_logs").insert({ plan_id, msg: `Login failed: ${loginResult.error}` });
        const response = jsonResponse({ ok:false, code:"LOGIN_FAILED", msg: loginResult.error }, 400);
        return res.status(response.statusCode).json(JSON.parse(response.body));
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
        const response = jsonResponse({
          ok: false,
          code: 'PAYMENT_NOT_READY',
          msg: 'Saved card CVV required (or set extras.allow_no_cvv=true if checkout never requests CVV).'
        }, 422);
        return res.status(response.statusCode).json(JSON.parse(response.body));
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
          const response = jsonResponse({
            ok: false,
            code: 'PAYMENT_NOT_READY',
            msg: 'Checkout requires full card entry. Save a card on your SkiClubPro account first.'
          }, 422);
          return res.status(response.statusCode).json(JSON.parse(response.body));
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
          const discoveredUrls = await discoverSignupUrls(page, plan.child_name);
          
          if (discoveredUrls.length === 0) {
            await supabase.from("plan_logs").insert({ plan_id, msg: "No signup URLs found for child" });
            const response = jsonResponse({ 
              ok: false, 
              code: 'NO_SIGNUP_URLS', 
              msg: 'No matching signup opportunities found for this child' 
            }, 404);
            return res.status(response.statusCode).json(JSON.parse(response.body));
          }
          
          // Update the plan with discovered URLs
          const discoveredUrl = discoveredUrls[0];
          await supabase
            .from('plans')
            .update({ discovered_url: discoveredUrl })
            .eq('id', plan_id);
            
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: `Discovered signup URL: ${discoveredUrl}` 
          });
          
          plan.discovered_url = discoveredUrl;
        } catch (discoveryError: any) {
          console.error("Discovery error:", discoveryError);
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: `Discovery failed: ${discoveryError.message}` 
          });
          const response = jsonResponse({ 
            ok: false, 
            code: 'DISCOVERY_FAILED', 
            msg: discoveryError.message 
          }, 500);
          return res.status(response.statusCode).json(JSON.parse(response.body));
        }
      }

      // Navigate to discovered/target URL
      const finalUrl = plan.discovered_url || targetUrl;
      await supabase.from("plan_logs").insert({ plan_id, msg: `Navigating to signup: ${finalUrl}` });
      await page.goto(finalUrl, { waitUntil: "domcontentloaded" });

      // Execute the signup
      const signupResult = await executeSignup(page, plan, credentials, supabase);
      
      if (!signupResult.success) {
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: `Signup failed: ${signupResult.error}` 
        });
        const response = jsonResponse({ 
          ok: false, 
          code: signupResult.code || 'SIGNUP_FAILED', 
          msg: signupResult.error,
          details: signupResult.details 
        }, signupResult.statusCode || 400);
        return res.status(response.statusCode).json(JSON.parse(response.body));
      }

      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Signup completed successfully" 
      });

      // Update plan status
      await supabase
        .from('plans')
        .update({ 
          status: signupResult.requiresAction ? 'action_required' : 'completed',
          completed_at: signupResult.requiresAction ? null : new Date().toISOString()
        })
        .eq('id', plan_id);

      const response = jsonResponse({ 
        ok: true, 
        msg: signupResult.requiresAction ? 'Signup initiated - action required' : 'Signup completed successfully',
        requiresAction: signupResult.requiresAction,
        details: signupResult.details
      });
      return res.status(response.statusCode).json(JSON.parse(response.body));

    } catch (error: any) {
      console.error("Execution error:", error);
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Execution error: ${error.message}` 
      });
      
      // Update plan status to failed
      await supabase
        .from('plans')
        .update({ status: 'failed' })
        .eq('id', plan_id);

      const response = jsonResponse({ 
        ok: false, 
        code: 'EXECUTION_ERROR', 
        msg: error.message 
      }, 500);
      return res.status(response.statusCode).json(JSON.parse(response.body));
    } finally {
      // Clean up browser connection
      if (browser) {
        try {
          await browser.close();
          await supabase.from("plan_logs").insert({ plan_id, msg: "Browser connection closed" });
        } catch (e) {
          console.error("Error closing browser:", e);
        }
      }
    }
  } catch (error: any) {
    console.error("Handler error:", error);
    const response = jsonResponse({ 
      ok: false, 
      code: 'HANDLER_ERROR', 
      msg: error.message 
    }, 500);
    return res.status(response.statusCode).json(JSON.parse(response.body));
  }
}

// Login with Playwright
async function loginWithPlaywright(page: any, loginUrl: string, email: string, password: string) {
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    
    // Wait for email field and fill it
    await page.waitForSelector('input[type="email"], input[name*="email"], input[id*="email"]', { timeout: 10000 });
    await page.fill('input[type="email"], input[name*="email"], input[id*="email"]', email);
    
    // Fill password field
    await page.fill('input[type="password"], input[name*="password"], input[id*="password"]', password);
    
    // Click login button
    await page.click('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in")');
    
    // Wait for navigation or success indicator
    await page.waitForTimeout(3000);
    
    // Check if we're logged in (look for dashboard or profile indicators)
    const currentUrl = page.url();
    const content = await page.content();
    
    if (currentUrl.includes('dashboard') || currentUrl.includes('profile') || 
        content.includes('logout') || content.includes('sign out')) {
      return { success: true };
    }
    
    // Check for error messages
    const errorSelectors = [
      '.error', '.alert-danger', '[class*="error"]', '[class*="invalid"]'
    ];
    
    for (const selector of errorSelectors) {
      const errorElement = await page.$(selector);
      if (errorElement) {
        const errorText = await errorElement.textContent();
        if (errorText && errorText.trim()) {
          return { success: false, error: `Login failed: ${errorText.trim()}` };
        }
      }
    }
    
    return { success: false, error: 'Login failed - please check credentials' };
  } catch (error: any) {
    return { success: false, error: `Login error: ${error.message}` };
  }
}

// Discover signup URLs
async function discoverSignupUrls(page: any, childName: string) {
  const urls: string[] = [];
  
  try {
    // Look for links containing signup, register, events, etc.
    const linkSelectors = [
      `a[href*="signup"]:has-text("${childName}")`,
      `a[href*="register"]:has-text("${childName}")`,
      `a[href*="event"]:has-text("${childName}")`,
      'a[href*="signup"]',
      'a[href*="register"]',
      'a[href*="event"]'
    ];
    
    for (const selector of linkSelectors) {
      const links = await page.$$(selector);
      for (const link of links) {
        const href = await link.getAttribute('href');
        if (href) {
          const fullUrl = new URL(href, page.url()).toString();
          if (!urls.includes(fullUrl)) {
            urls.push(fullUrl);
          }
        }
      }
    }
    
    return urls;
  } catch (error) {
    console.error("Discovery error:", error);
    return [];
  }
}

// Execute signup process
async function executeSignup(page: any, plan: any, credentials: any, supabase: any) {
  try {
    const plan_id = plan.id;
    
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: "Starting signup process..." 
    });
    
    // Look for signup forms
    const forms = await page.$$('form');
    
    if (forms.length === 0) {
      return { 
        success: false, 
        error: 'No signup form found on page',
        code: 'NO_SIGNUP_FORM'
      };
    }
    
    // Try to fill out the signup form
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: "Filling signup form..." 
    });
    
    // Fill common form fields
    const nameFields = await page.$$('input[name*="name"], input[id*="name"]');
    if (nameFields.length > 0) {
      await nameFields[0].fill(plan.child_name);
    }
    
    const emailFields = await page.$$('input[type="email"], input[name*="email"]');
    if (emailFields.length > 0) {
      await emailFields[0].fill(credentials.email);
    }
    
    // Handle payment if CVV is available
    if (credentials.cvv) {
      const cvvFields = await page.$$('input[name*="cvv"], input[name*="security"], input[placeholder*="CVV"]');
      if (cvvFields.length > 0) {
        await cvvFields[0].fill(credentials.cvv);
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "CVV entered for payment" 
        });
      }
    }
    
    // Submit the form
    const submitButtons = await page.$$('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Register")');
    if (submitButtons.length > 0) {
      await submitButtons[0].click();
      await page.waitForTimeout(3000);
      
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Signup form submitted" 
      });
    }
    
    // Check for success or action required
    const content = await page.content().catch(() => '');
    const currentUrl = page.url();
    
    // Check for confirmation or success messages
    if (content.includes('confirm') || content.includes('verification') || 
        content.includes('check your email') || currentUrl.includes('confirm')) {
      return { 
        success: true, 
        requiresAction: true,
        details: { message: 'Email confirmation required' }
      };
    }
    
    // Check for payment confirmation
    if (content.includes('payment') && content.includes('confirm')) {
      return { 
        success: true, 
        requiresAction: true,
        details: { message: 'Payment confirmation required' }
      };
    }
    
    // Check for success
    if (content.includes('success') || content.includes('registered') || 
        content.includes('signed up') || currentUrl.includes('success')) {
      return { 
        success: true, 
        requiresAction: false,
        details: { message: 'Signup completed successfully' }
      };
    }
    
    // Default to requiring action if we can't determine the outcome
    return { 
      success: true, 
      requiresAction: true,
      details: { message: 'Signup submitted - please check for confirmation' }
    };
    
  } catch (error: any) {
    return { 
      success: false, 
      error: `Signup execution failed: ${error.message}`,
      code: 'SIGNUP_EXECUTION_ERROR'
    };
  }
}
