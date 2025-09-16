console.log("🚀 Worker starting up...");
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json());

// ===== POLICY CONSTANTS =====
const CAPTCHA_AUTOSOLVE_ENABLED = false; // NEVER call a CAPTCHA solver - SMS + verify link only
const PER_USER_WEEKLY_LIMIT = 3; // Maximum plans per user per 7 days  
const SMS_IMMEDIATE_ON_ACTION_REQUIRED = true; // Send SMS immediately when action required

// Debug logging helper - set DEBUG_VERBOSE=1 in environment to enable verbose logs
const DEBUG_VERBOSE = process.env.DEBUG_VERBOSE === "1";
function dlog(...args) { 
  if (DEBUG_VERBOSE) console.log(...args); 
}

// Health check
app.get("/health", (req, res) => {
  console.log("⚡ Health check hit");
  res.json({ ok: true });
});

// Run-plan endpoint - full automation logic
app.post("/run-plan", async (req, res) => {
  const plan_id = req.body?.plan_id || "unknown";
  console.log(`🎯 /run-plan request for plan_id: ${plan_id}`);

  if (!plan_id) {
    return res.status(400).json({ error: "plan_id is required" });
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
    
    const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (missingEnvVars.length > 0) {
      console.error('Missing environment variables:', missingEnvVars);
      return res.status(500).json({ 
        ok: false, 
        code: 'MISSING_ENV', 
        msg: `Missing environment variables: ${missingEnvVars.join(', ')}`,
        details: { missingVars: missingEnvVars }
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    console.log(`Starting plan execution for plan_id: ${plan_id}`);

    // Log the start of the attempt
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Worker: Attempt started - loading plan details...'
    });

    // Fetch plan details using service role
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('*')
      .eq('id', plan_id)
      .maybeSingle();

    if (planError || !plan) {
      const errorMsg = 'Plan not found or access denied';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker Error: ${errorMsg}`
      });
      
      return res.status(404).json({ 
        ok: false, 
        code: 'PLAN_NOT_FOUND', 
        msg: errorMsg,
        details: { plan_id, planError: planError?.message }
      });
    }

    // ===== SINGLE-EXECUTION POLICY =====
    if (plan.status !== 'scheduled' && plan.status !== 'action_required' && plan.status !== 'executing') {
      console.log(`Ignoring execution request for plan ${plan_id} with status '${plan.status}' - only 'scheduled', 'action_required', or 'executing' plans can be executed`);
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker: Execution ignored - plan status is '${plan.status}' (cannot execute ${plan.status === 'cancelled' ? 'cancelled' : plan.status} plans)`
      });
      
      return res.status(200).json({ 
        ok: false, 
        code: 'INVALID_PLAN_STATUS', 
        msg: `Plan execution ignored - status is '${plan.status}'`,
        details: { 
          current_status: plan.status, 
          allowed_statuses: ['scheduled', 'action_required', 'executing'] 
        }
      });
    }

    // Log plan details found
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Plan loaded: ${plan.child_name} at ${plan.org} - proceeding with execution`
    });

    // Update plan status to executing
    await supabase
      .from('plans')
      .update({ status: 'executing' })
      .eq('id', plan_id);

    // Fetch credentials using service role
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Worker: Retrieving account credentials...'
    });

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
        msg: `Worker Error: ${errorMsg}`
      });
      
      return res.status(404).json({ 
        ok: false, 
        code: 'CREDENTIALS_NOT_FOUND', 
        msg: errorMsg,
        details: { credential_id: plan.credential_id, credError: credError?.message }
      });
    }

    // Decrypt credentials using the encryption key
    const CRED_ENC_KEY = process.env.CRED_ENC_KEY;
    if (!CRED_ENC_KEY) {
      const errorMsg = 'Encryption key not configured';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker Error: ${errorMsg}`
      });
      
      return res.status(500).json({ 
        ok: false, 
        code: 'MISSING_ENCRYPTION_KEY', 
        msg: errorMsg 
      });
    }

    // Decrypt function (matching cred-store implementation)
    async function decrypt(encryptedString) {
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

    let credentials;
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
        msg: `Worker Error: ${errorMsg}`
      });
      
      return res.status(500).json({ 
        ok: false, 
        code: 'DECRYPTION_FAILED', 
        msg: errorMsg,
        details: { error: decryptError.message }
      });
    }

    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Using account: ${credentials.alias} (${credentials.email})`
    });

    // ===== RESOLVE EXTRAS / AUTOS =====
    const EXTRAS = (plan?.extras ?? {});

    // Support both extras.* and top-level fallback (back-compat)
    function isAuto(v) {
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
    const browserbaseApiKey = process.env.BROWSERBASE_API_KEY;
    const browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID;
    
    let session = null;
    let browser = null;
    
    try {
      const sessionResp = await fetch("https://api.browserbase.com/v1/sessions", {
        method: "POST",
        headers: { "X-BB-API-Key": browserbaseApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: browserbaseProjectId })
      });
      if (!sessionResp.ok) {
        const t = await sessionResp.text().catch(()=>"");
        console.error("Session create failed:", sessionResp.status, sessionResp.statusText, t);
        await supabase.from("plan_logs").insert({ plan_id, msg: `Worker Error: Browserbase session failed ${sessionResp.status}` });
        return res.status(500).json({ ok:false, code:"BROWSERBASE_SESSION_FAILED", msg:"Cannot create browser session" });
      }
      session = await sessionResp.json();
      dlog("Browserbase session created:", session);
      await supabase.from("plan_logs").insert({ plan_id, msg: `Worker: ✅ Browserbase session created: ${session.id}` });

      // Connect Playwright over CDP
      let page = null;
      try {
        await supabase.from("plan_logs").insert({
          plan_id,
          msg: "Worker: PLAYWRIGHT_CONNECT_START"
        });
        
        browser = await chromium.connectOverCDP(session.connectUrl);
        
        await supabase.from("plan_logs").insert({
          plan_id,
          msg: "Worker: PLAYWRIGHT_CONNECT_SUCCESS"
        });

        const ctx = browser.contexts()[0] ?? await browser.newContext();
        page = ctx.pages()[0] ?? await ctx.newPage();

        await supabase.from("plan_logs").insert({ plan_id, msg: "Worker: Playwright connected" });
        dlog("Connected Playwright to session:", session.id);
        await supabase.from("plan_logs").insert({ plan_id, msg: "Worker: Playwright connected to Browserbase" });
      } catch (e) {
        console.error("Playwright connect error:", e);
        await supabase.from("plan_logs").insert({
          plan_id,
          msg: "Worker: PLAYWRIGHT_CONNECT_FAILED: " + (e?.message ?? String(e))
        });
        return res.status(500).json({ ok:false, code:"PLAYWRIGHT_CONNECT_FAILED", msg:"Cannot connect Playwright" });
      }

      // Normalize plan.base_url to root domain
      let normalizedBaseUrl;
      if (plan.base_url) {
        try {
          const url = new URL(plan.base_url);
          normalizedBaseUrl = `${url.protocol}//${url.host}`;
        } catch {
          // Fallback if base_url is invalid
          const subdomain = (plan.org || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          normalizedBaseUrl = `https://${subdomain}.skiclubpro.team`;
        }
      } else {
        const subdomain = (plan.org || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        normalizedBaseUrl = `https://${subdomain}.skiclubpro.team`;
      }
      
      const loginUrl = `${normalizedBaseUrl}/user/login`;
      console.log(`Worker: Normalized login URL = ${loginUrl}`);
      
      // Perform login with Playwright
      await supabase.from("plan_logs").insert({ plan_id, msg: `Worker: Navigating to login: ${loginUrl}` });
      const loginResult = await loginWithPlaywright(page, loginUrl, credentials.email, credentials.password);
      if (!loginResult.success) {
        await supabase.from("plan_logs").insert({ plan_id, msg: `Worker: Login failed: ${loginResult.error}` });
        return res.status(400).json({ ok:false, code:"LOGIN_FAILED", msg: loginResult.error });
      }
      await supabase.from("plan_logs").insert({ plan_id, msg: "Worker: Login successful" });

      //// ===== PAYMENT READINESS GATE =====
      await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: Checking payment readiness…' });

      // We handle saved-card + CVV flows; allow override if site never asks for CVV.
      const hasCVV = !!(credentials?.cvv && String(credentials.cvv).trim().length > 0);
      if (!allowNoCvv && !hasCVV) {
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: 'Worker: Payment not ready: saved card CVV required or set extras.allow_no_cvv=true'
        });
        return res.status(422).json({
          ok: false,
          code: 'PAYMENT_NOT_READY',
          msg: 'Saved card CVV required (or set extras.allow_no_cvv=true if checkout never requests CVV).'
        });
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
            msg: 'Worker: Detected full-card fields; saved card required. Aborting.'
          });
          return res.status(422).json({
            ok: false,
            code: 'PAYMENT_NOT_READY',
            msg: 'Checkout requires full card entry. Save a card on your SkiClubPro account first.'
          });
        }
      } catch { /* non-fatal */ }

      // Navigate to target page for Blackhawk flow
      const targetUrl = plan.discovered_url || plan.base_url || `https://${subdomain}.skiclubpro.team/dashboard`;
      await supabase.from("plan_logs").insert({ plan_id, msg: `Worker: Opening target page: ${targetUrl}` });
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

      // Execute the Blackhawk-specific signup flow (no separate discovery needed)
      const signupResult = await executeSignup(page, plan, credentials, supabase);
      
      if (!signupResult.success) {
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: `Worker: Signup failed: ${signupResult.error}` 
        });
        return res.status(signupResult.statusCode || 400).json({ 
          ok: false, 
          code: signupResult.code || 'SIGNUP_FAILED', 
          msg: signupResult.error,
          details: signupResult.details 
        });
      }

      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Worker: Signup completed successfully" 
      });

      // Update plan status
      await supabase
        .from('plans')
        .update({ 
          status: signupResult.requiresAction ? 'action_required' : 'completed',
          completed_at: signupResult.requiresAction ? null : new Date().toISOString()
        })
        .eq('id', plan_id);

      res.json({ 
        ok: true, 
        msg: signupResult.requiresAction ? 'Signup initiated - action required' : 'Signup completed successfully',
        requiresAction: signupResult.requiresAction,
        details: signupResult.details,
        sessionId: session.id,
        plan_id
      });

    } catch (error) {
      console.error("Execution error:", error);
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Worker: Execution error: ${error.message}` 
      });
      
      // Update plan status to failed
      await supabase
        .from('plans')
        .update({ status: 'failed' })
        .eq('id', plan_id);

      res.status(500).json({ 
        ok: false, 
        code: 'EXECUTION_ERROR', 
        msg: error.message 
      });
    } finally {
      // Clean up browser connection and Browserbase session
      if (browser) {
        try {
          await browser.close();
          await supabase.from("plan_logs").insert({ plan_id, msg: "Worker: Browser connection closed" });
        } catch (e) {
          console.error("Error closing browser:", e);
        }
      }
      
      // Close Browserbase session
      if (session) {
        try {
          await fetch(`https://api.browserbase.com/v1/sessions/${session.id}`, {
            method: "DELETE",
            headers: { "X-BB-API-Key": process.env.BROWSERBASE_API_KEY }
          });
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: Browserbase session closed" 
          });
        } catch (e) {
          console.error("Error closing Browserbase session:", e);
        }
      }
    }
  } catch (error) {
    console.error("❌ Worker error in /run-plan:", error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// Login with Playwright
async function loginWithPlaywright(page, loginUrl, email, password) {
  try {
    console.log("Worker: Navigating to login");
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Save debug screenshot
    await page.screenshot({ path: "login-debug.png" });
    console.log("Worker: Screenshot saved");
    
    // Explicitly wait for email and password fields after navigation
    console.log("Worker: Waiting for email/password fields");
    await page.waitForSelector('#edit-name', { timeout: 20000 });
    await page.waitForSelector('#edit-pass', { timeout: 20000 });
    
    // Fill email field
    console.log("Worker: Filling email");
    await page.fill('#edit-name', email);
    
    // Fill password field  
    console.log("Worker: Filling password");
    await page.fill('#edit-pass', password);
    
    // Click login button
    console.log("Worker: Clicking login button");
    await page.click('#edit-submit');
    
    // Wait for dashboard URL after login
    try {
      await page.waitForURL(/dashboard/, { timeout: 30000 });
      console.log("Worker: Login successful");
      return { success: true };
    } catch (error) {
      // Fallback: check current URL and content for login success indicators
      const currentUrl = page.url();
      const content = await page.content();
      
      if (currentUrl.includes('dashboard') || currentUrl.includes('profile') || 
          content.includes('logout') || content.includes('sign out')) {
        console.log("Worker: Login successful");
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
    }
  } catch (error) {
    return { success: false, error: `Login error: ${error.message}` };
  }
}

// Blackhawk-specific discovery: Find and click Register for Nordic Kids Wednesday
async function discoverBlackhawkRegistration(page, plan, supabase) {
  const plan_id = plan.id;
  
  try {
    // Navigate to registration page
    const baseUrl = page.url().split('/').slice(0, 3).join('/'); // Get base domain
    const registrationUrl = `${baseUrl}/registration`;
    
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: Navigating to registration page: ${registrationUrl}` 
    });
    
    await page.goto(registrationUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000); // Wait for page to fully load
    
    // Look for Nordic Kids Wednesday program
    const content = (await page.content()).toLowerCase();
    if (!content.includes('nordic kids wednesday')) {
      // Try alternative registration events page
      const eventsUrl = `${baseUrl}/registration/events`;
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Worker: Nordic Kids Wednesday not found, trying events page: ${eventsUrl}` 
      });
      
      await page.goto(eventsUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      
      const eventsContent = (await page.content()).toLowerCase();
      if (!eventsContent.includes('nordic kids wednesday')) {
        throw new Error('Nordic Kids Wednesday program not found on registration pages');
      }
    }
    
    // Find and click the Register button for Nordic Kids Wednesday
    const registerSelectors = [
      'button:has-text("Register")',
      'a:has-text("Register")',
      'input[type="submit"][value*="Register" i]',
      '[value*="Register" i]'
    ];
    
    let registerClicked = false;
    
    // Try to find Register button near "Nordic Kids Wednesday" text
    for (const selector of registerSelectors) {
      const elements = await page.$$(selector);
      
      for (const element of elements) {
        // Check if this Register button is associated with Nordic Kids Wednesday
        const parentRow = await element.locator('xpath=ancestor::tr | ancestor::div[contains(@class,"row")] | ancestor::div[contains(@class,"program")] | ancestor::section').first();
        
        if (parentRow) {
          try {
            const rowText = (await parentRow.textContent()).toLowerCase();
            if (rowText.includes('nordic kids wednesday')) {
              await element.scrollIntoViewIfNeeded();
              await element.waitFor({ state: "visible" });
              await element.click();
              
              await supabase.from("plan_logs").insert({ 
                plan_id, 
                msg: "Worker: Register clicked for Nordic Kids Wednesday" 
              });
              
              registerClicked = true;
              break;
            }
          } catch (error) {
            // Continue to next element if textContent fails
            continue;
          }
        }
      }
      
      if (registerClicked) break;
    }
    
    if (!registerClicked) {
      // Fallback: click first Register button if Nordic Kids Wednesday text is on page
      const fallbackElements = await page.$$(registerSelectors[0]);
      if (fallbackElements.length > 0) {
        await fallbackElements[0].scrollIntoViewIfNeeded();
        await fallbackElements[0].waitFor({ state: "visible" });
        await fallbackElements[0].click();
        
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: Register clicked (fallback) for Nordic Kids Wednesday" 
        });
        
        registerClicked = true;
      }
    }
    
    if (!registerClicked) {
      throw new Error('No Register button found for Nordic Kids Wednesday');
    }
    
    // Wait for navigation to /registration/*/start
    try {
      await page.waitForURL(/\/registration\/.*\/start/, { timeout: 30000 });
      return { success: true, startUrl: page.url() };
    } catch (error) {
      // Check if we're on a start-like page anyway
      const currentUrl = page.url();
      if (currentUrl.includes('/registration/') && (currentUrl.includes('/start') || currentUrl.includes('participant'))) {
        return { success: true, startUrl: currentUrl };
      }
      
      throw new Error(`Failed to navigate to start page after clicking Register: ${error.message}`);
    }
    
  } catch (error) {
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: Blackhawk registration discovery failed: ${error.message}` 
    });
    
    return { 
      success: false, 
      error: `Blackhawk registration discovery failed: ${error.message}` 
    };
  }
}

// Reliable button click helper with scrolling, visibility, and retries
async function reliableClick(page, selectors, plan_id, supabase, actionName) {
  const maxRetries = 3;
  const retryDelay = 500;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    for (const selector of selectors) {
      try {
        const buttons = await page.$$(selector);
        if (buttons.length > 0) {
          const button = buttons[0];
          
          // Scroll into view and wait for visibility
          await button.scrollIntoViewIfNeeded();
          await button.waitFor({ state: "visible" });
          
          // Click the button
          await button.click();
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: `Worker: Successfully clicked ${actionName} button (${selector})` 
          });
          return true;
        }
      } catch (error) {
        // Continue to next selector or retry
      }
    }
    
    if (attempt < maxRetries) {
      await page.waitForTimeout(retryDelay);
    }
  }
  
  // Log available buttons for debugging
  try {
    const pageContent = await page.content();
    const snippet = pageContent.substring(0, 200);
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: No ${actionName} button found after ${maxRetries} retries. Page snippet: ${snippet}` 
    });
  } catch {
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: No ${actionName} button found after ${maxRetries} retries` 
    });
  }
  
  return false;
}

// Handle Blackhawk Options page - only runs on /registration/*/options URL
async function handleBlackhawkOptions(page, plan, supabase) {
  const plan_id = plan.id;
  const currentUrl = page.url();
  
  // Only run on options page
  if (!currentUrl.match(/\/registration\/.*\/options/)) {
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: "Worker: Not on options page, skipping add-on handling" 
    });
    return { success: true };
  }
  
  await supabase.from("plan_logs").insert({ 
    plan_id, 
    msg: "Worker: Processing Blackhawk options page..." 
  });
  
  try {
    const EXTRAS = (plan?.extras ?? {});
    
    // Handle Color Group field
    const colorGroupValue = EXTRAS.nordicColorGroup;
    const colorGroupSelectors = [
      'select[name*="color"], select[id*="color"]',
      'input[type="radio"][name*="color"]',
      'input[type="checkbox"][name*="color"]'
    ];
    
    try {
      let colorGroupHandled = false;
      for (const selector of colorGroupSelectors) {
        const elements = await page.$$(selector);
        if (elements.length > 0) {
          const element = elements[0];
          const tagName = await element.evaluate(el => el.tagName.toLowerCase());
          
          if (tagName === 'select') {
            const options = await element.$$('option');
            let selectedOption = null;
            
            // Try to find matching color group
            if (colorGroupValue) {
              for (const option of options) {
                const optionText = await option.textContent();
                if (optionText && optionText.toLowerCase().includes(colorGroupValue.toLowerCase())) {
                  selectedOption = optionText;
                  await element.selectOption({ label: optionText });
                  break;
                }
              }
            }
            
            // Default to first option if not found or not specified
            if (!selectedOption && options.length > 1) {
              const firstOption = await options[1].textContent(); // Skip first empty option
              await element.selectOption({ index: 1 });
              selectedOption = firstOption;
            }
            
            if (selectedOption) {
              const logMsg = colorGroupValue && selectedOption.toLowerCase().includes(colorGroupValue.toLowerCase()) 
                ? `Worker: Color group selected: ${selectedOption}`
                : `Worker: Defaulted to first color group option: ${selectedOption}`;
              await supabase.from("plan_logs").insert({ plan_id, msg: logMsg });
              colorGroupHandled = true;
            }
          } else {
            // Handle radio buttons - select first or matching
            let selectedLabel = null;
            
            if (colorGroupValue) {
              for (const radioElement of elements) {
                const label = await page.evaluate(el => {
                  const labelEl = document.querySelector(`label[for="${el.id}"]`);
                  return labelEl ? labelEl.textContent : el.closest('label')?.textContent || '';
                }, radioElement);
                
                if (label && label.toLowerCase().includes(colorGroupValue.toLowerCase())) {
                  await radioElement.click();
                  selectedLabel = label;
                  break;
                }
              }
            }
            
            // Default to first option
            if (!selectedLabel && elements.length > 0) {
              await elements[0].click();
              selectedLabel = await page.evaluate(el => {
                const labelEl = document.querySelector(`label[for="${el.id}"]`);
                return labelEl ? labelEl.textContent : el.closest('label')?.textContent || 'First option';
              }, elements[0]);
            }
            
            if (selectedLabel) {
              const logMsg = colorGroupValue && selectedLabel.toLowerCase().includes(colorGroupValue.toLowerCase()) 
                ? `Worker: Color group selected: ${selectedLabel}`
                : `Worker: Defaulted to first color group option: ${selectedLabel}`;
              await supabase.from("plan_logs").insert({ plan_id, msg: logMsg });
              colorGroupHandled = true;
            }
          }
          
          if (colorGroupHandled) break;
        }
      }
      
      if (!colorGroupHandled) {
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: Color group skipped (no fields found)" 
        });
      }
    } catch (error) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Worker: Color group error (non-blocking): ${error.message}` 
      });
    }
    
    // Handle Rental field
    const rentalValue = EXTRAS.nordicRental;
    const rentalSelectors = [
      'select[name*="rental"], select[id*="rental"]',
      'input[type="radio"][name*="rental"]',
      'input[type="checkbox"][name*="rental"]'
    ];
    
    try {
      let rentalHandled = false;
      for (const selector of rentalSelectors) {
        const elements = await page.$$(selector);
        if (elements.length > 0) {
          const element = elements[0];
          const tagName = await element.evaluate(el => el.tagName.toLowerCase());
          
          if (tagName === 'select') {
            // Handle dropdown
            const options = await element.$$('option');
            let selectedOption = null;
            
            // Try to match provided rental value
            if (rentalValue) {
              for (const option of options) {
                const optionText = await option.textContent();
                if (optionText && optionText.toLowerCase().includes(rentalValue.toLowerCase())) {
                  await element.selectOption({ label: optionText });
                  selectedOption = optionText;
                  break;
                }
              }
            }
            
            // Default to first visible option if not provided or not found
            if (!selectedOption && options.length > 1) {
              const firstOption = await options[1].textContent(); // Skip first empty option
              await element.selectOption({ index: 1 });
              selectedOption = firstOption;
            }
            
            if (selectedOption) {
              const logMsg = rentalValue && selectedOption.toLowerCase().includes(rentalValue.toLowerCase()) 
                ? `Worker: Rental selected: ${selectedOption}`
                : `Worker: Defaulted to first rental option: ${selectedOption}`;
              await supabase.from("plan_logs").insert({ plan_id, msg: logMsg });
              rentalHandled = true;
            }
          } else {
            // Handle radio buttons/checkboxes
            let selectedLabel = null;
            
            // Try to match provided rental value
            if (rentalValue) {
              for (const radioElement of elements) {
                const label = await page.evaluate(el => {
                  const labelEl = document.querySelector(`label[for="${el.id}"]`);
                  return labelEl ? labelEl.textContent : el.closest('label')?.textContent || '';
                }, radioElement);
                
                if (label && label.toLowerCase().includes(rentalValue.toLowerCase())) {
                  await radioElement.click();
                  selectedLabel = label;
                  break;
                }
              }
            }
            
            // Default to first option if not found or not provided
            if (!selectedLabel && elements.length > 0) {
              await elements[0].click();
              selectedLabel = await page.evaluate(el => {
                const labelEl = document.querySelector(`label[for="${el.id}"]`);
                return labelEl ? labelEl.textContent : el.closest('label')?.textContent || 'First option';
              }, elements[0]);
            }
            
            if (selectedLabel) {
              const logMsg = rentalValue && selectedLabel.toLowerCase().includes(rentalValue.toLowerCase()) 
                ? `Worker: Rental selected: ${selectedLabel}`
                : `Worker: Defaulted to first rental option: ${selectedLabel}`;
              await supabase.from("plan_logs").insert({ plan_id, msg: logMsg });
              rentalHandled = true;
            }
          }
          
          if (rentalHandled) break;
        }
      }
      
      if (!rentalHandled) {
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: Rental skipped (no fields found)" 
        });
      }
    } catch (error) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Worker: Rental error (non-blocking): ${error.message}` 
      });
    }
    
    // Handle Volunteer field
    const volunteerValue = EXTRAS.volunteer;
    const volunteerSelectors = [
      'input[type="checkbox"][name*="volunteer"]',
      'input[type="radio"][name*="volunteer"]',
      'select[name*="volunteer"], select[id*="volunteer"]'
    ];
    
    try {
      let volunteerHandled = false;
      for (const selector of volunteerSelectors) {
        const elements = await page.$$(selector);
        if (elements.length > 0) {
          const element = elements[0];
          const tagName = await element.evaluate(el => el.tagName.toLowerCase());
          
          if (tagName === 'select') {
            let selectedOption = null;
            const options = await element.$$('option');
            
            if (volunteerValue) {
              for (const option of options) {
                const optionText = await option.textContent();
                if (optionText && optionText.toLowerCase().includes(volunteerValue.toLowerCase())) {
                  await element.selectOption({ label: optionText });
                  selectedOption = optionText;
                  break;
                }
              }
            }
            
            // Default to first non-empty option
            if (!selectedOption && options.length > 1) {
              const firstOption = await options[1].textContent();
              await element.selectOption({ index: 1 });
              selectedOption = firstOption;
            }
            
            if (selectedOption) {
              const logMsg = volunteerValue && selectedOption.toLowerCase().includes(volunteerValue.toLowerCase()) 
                ? `Worker: Volunteer selected: ${selectedOption}`
                : `Worker: Defaulted to first volunteer option: ${selectedOption}`;
              await supabase.from("plan_logs").insert({ plan_id, msg: logMsg });
              volunteerHandled = true;
            }
          } else {
            // Handle checkboxes/radio buttons
            let selectedLabel = null;
            
            if (volunteerValue) {
              for (const checkboxElement of elements) {
                const label = await page.evaluate(el => {
                  const labelEl = document.querySelector(`label[for="${el.id}"]`);
                  return labelEl ? labelEl.textContent : el.closest('label')?.textContent || '';
                }, checkboxElement);
                
                if (label && label.toLowerCase().includes(volunteerValue.toLowerCase())) {
                  await checkboxElement.click();
                  selectedLabel = label;
                  break;
                }
              }
            }
            
            // Default to first checkbox
            if (!selectedLabel && elements.length > 0) {
              await elements[0].click();
              selectedLabel = await page.evaluate(el => {
                const labelEl = document.querySelector(`label[for="${el.id}"]`);
                return labelEl ? labelEl.textContent : el.closest('label')?.textContent || 'First option';
              }, elements[0]);
            }
            
            if (selectedLabel) {
              const logMsg = volunteerValue && selectedLabel.toLowerCase().includes(volunteerValue.toLowerCase()) 
                ? `Worker: Volunteer selected: ${selectedLabel}`
                : `Worker: Defaulted to first volunteer option: ${selectedLabel}`;
              await supabase.from("plan_logs").insert({ plan_id, msg: logMsg });
              volunteerHandled = true;
            }
          }
          
          if (volunteerHandled) break;
        }
      }
      
      if (!volunteerHandled) {
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: Volunteer skipped (no fields found)" 
        });
      }
    } catch (error) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Worker: Volunteer error (non-blocking): ${error.message}` 
      });
    }
    
    // Click Next to proceed to cart
    const nextButtonSelectors = [
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'input[type="submit"][value*="Next" i]',
      'input[type="submit"][value*="Continue" i]',
      'button[type="submit"]',
      'input[type="submit"]'
    ];
    
    const clicked = await reliableClick(page, nextButtonSelectors, plan_id, supabase, "Next");
    if (clicked) {
      // Wait for navigation to cart
      try {
        await page.waitForURL(/\/cart/, { timeout: 30000 });
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: Navigated to cart after options" 
        });
      } catch (error) {
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: `Worker: Navigation to cart may have failed: ${error.message}` 
        });
      }
    }
    
  } catch (error) {
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: Blackhawk options error (non-blocking): ${error.message}` 
    });
  }
  
  // Always return success to ensure non-blocking execution
  return { success: true };
}

async function executeSignup(page, plan, credentials, supabase) {
  try {
    const plan_id = plan.id;
    
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: "Worker: Starting Blackhawk multi-step signup process..." 
    });
    
    // Step 1: Blackhawk Registration Discovery - Find and click Register for Nordic Kids Wednesday
    const discoveryResult = await discoverBlackhawkRegistration(page, plan, supabase);
    if (!discoveryResult.success) {
      return { 
        success: false, 
        error: discoveryResult.error,
        code: 'BLACKHAWK_DISCOVERY_FAILED'
      };
    }
    
    // Step 2: Start Page - Select participant
    const currentUrl = page.url();
    if (currentUrl.match(/\/registration\/.*\/start/)) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Worker: On start page, selecting participant..." 
      });
      
      // Look for participant dropdown and select matching child
      const participantSelectors = [
        'select[name*="participant"]',
        'select[id*="participant"]',
        'select[name*="child"]',
        'select[id*="child"]',
        'select' // fallback to any select element
      ];
      
      let participantSelected = false;
      for (const selector of participantSelectors) {
        const selects = await page.$$(selector);
        if (selects.length > 0) {
          const selectElement = selects[0];
          const options = await selectElement.$$('option');
          
          // Try to find matching participant by name
          for (const option of options) {
            const optionText = await option.textContent();
            if (optionText && optionText.toLowerCase().includes(plan.child_name.toLowerCase())) {
              await selectElement.selectOption({ label: optionText });
              await supabase.from("plan_logs").insert({ 
                plan_id, 
                msg: `Worker: Participant selected: ${optionText}` 
              });
              participantSelected = true;
              break;
            }
          }
          
          // Fallback to first non-empty option if exact match not found
          if (!participantSelected && options.length > 1) {
            const firstOption = await options[1].textContent();
            await selectElement.selectOption({ index: 1 });
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: `Worker: Participant selected (fallback): ${firstOption}` 
            });
            participantSelected = true;
          }
          
          if (participantSelected) break;
        }
      }
      
      if (!participantSelected) {
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: No participant dropdown found, continuing..." 
        });
      }
      
      // Click Next to go to options page
      const nextSelectors = [
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'input[type="submit"][value*="Next" i]',
        'input[type="submit"][value*="Continue" i]',
        'button[type="submit"]'
      ];
      
      const nextClicked = await reliableClick(page, nextSelectors, plan_id, supabase, "Next");
      if (nextClicked) {
        try {
          await page.waitForURL(/\/registration\/.*\/options/, { timeout: 30000 });
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: Navigated to options page" 
          });
        } catch (error) {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: `Worker: Navigation to options may have failed: ${error.message}` 
          });
        }
      } else {
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: No Next button found on start page" 
        });
      }
    }
    
    // Step 3: Options Page - Handle add-ons
    const optionsUrl = page.url();
    if (optionsUrl.match(/\/registration\/.*\/options/)) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Worker: On options page, processing add-ons..." 
      });
      
      // Handle add-ons using the dedicated function
      await handleBlackhawkOptions(page, plan, supabase);
      
      // Function handles Next click and navigation to cart
    }
    
    // Step 4: Cart and Checkout State Machine
    let maxStateLoops = 10; // Prevent infinite loops
    let currentLoop = 0;
    
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: "Worker: Starting checkout state machine..." 
    });
    
    while (currentLoop < maxStateLoops) {
      currentLoop++;
      const stateUrl = page.url();
      
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Worker: Current URL: ${stateUrl}` 
      });
      
      if (stateUrl.includes('/cart')) {
        // Cart state: click Checkout button
        const checkoutSelectors = [
          'button:has-text("Checkout")',
          '#edit-checkout',
          'input[type="submit"][value*="Checkout" i]',
          '[value*="Checkout" i]'
        ];
        
        const checkoutClicked = await reliableClick(page, checkoutSelectors, plan_id, supabase, "Checkout");
        if (checkoutClicked) {
          // Wait for navigation to installments page
          try {
            await page.waitForURL(/\/checkout\/\d+\/installments/, { timeout: 30000 });
            continue; // Go to next iteration to handle installments state
          } catch (error) {
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: `Worker: Failed to navigate to installments page: ${error.message}` 
            });
            break;
          }
        } else {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: No checkout button found, breaking state machine" 
          });
          break;
        }
        
      } else if (stateUrl.match(/\/checkout\/\d+\/installments/)) {
        // Installments state: ensure saved card selected and click Continue to Review
        
        // Ensure saved card radio button is selected
        const savedCardRadios = await page.$$('input[type="radio"]');
        if (savedCardRadios.length > 0) {
          const isChecked = await savedCardRadios[0].isChecked();
          if (!isChecked) {
            await savedCardRadios[0].scrollIntoViewIfNeeded();
            await savedCardRadios[0].click();
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: "Worker: Selected saved card payment method" 
            });
          }
        }
        
        // Click Continue to Review
        const continueSelectors = [
          'button:has-text("Continue to Review")',
          'input[type="submit"][value*="Continue" i]',
          '[value*="Continue" i]'
        ];
        
        const continueClicked = await reliableClick(page, continueSelectors, plan_id, supabase, "Continue to Review");
        if (continueClicked) {
          // Wait for navigation to review page
          try {
            await page.waitForURL(/\/checkout\/\d+\/review/, { timeout: 30000 });
            continue; // Go to next iteration to handle review state
          } catch (error) {
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: `Worker: Failed to navigate to review page: ${error.message}` 
            });
            break;
          }
        } else {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: No continue button found, breaking state machine" 
          });
          break;
        }
        
      } else if (stateUrl.match(/\/checkout\/\d+\/review/)) {
        // Review state: click Pay and complete purchase
        
        // Fill CVV if available and field exists
        if (credentials.cvv) {
          const cvvSelectors = [
            'input[name*="cvv"]', 'input[id*="cvv"]', 'input[name*="security"]',
            'input[id*="security"]', 'input[placeholder*="CVV"]', 'input[name*="cvc"]'
          ];
          
          for (const selector of cvvSelectors) {
            const cvvFields = await page.$$(selector);
            if (cvvFields.length > 0) {
              await cvvFields[0].fill(String(credentials.cvv));
              await supabase.from("plan_logs").insert({ 
                plan_id, 
                msg: "Worker: CVV entered for payment" 
              });
              break;
            }
          }
        }
        
        const paySelectors = [
          'button:has-text("Pay and complete purchase")',
          'button:has-text("Complete Purchase")',
          'button:has-text("Pay Now")',
          'input[type="submit"][value*="Complete" i]',
          'input[type="submit"][value*="Pay" i]',
          '[value*="Complete" i]'
        ];
        
        const payClicked = await reliableClick(page, paySelectors, plan_id, supabase, "Pay and complete purchase");
        if (payClicked) {
          // Wait for completion page or success indicators
          try {
            await Promise.race([
              page.waitForURL(/\/checkout\/\d+\/complete/, { timeout: 30000 }),
              page.waitForURL(/\/(complete|thank-you|success|confirmation)/, { timeout: 30000 }),
              page.waitForSelector('text=/Thank you|Registration complete|successfully registered/i', { timeout: 30000 })
            ]);
            
            // Check current state after payment
            const finalUrl = page.url();
            const finalContent = await page.content().catch(() => '');
            
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: `Worker: After payment - URL: ${finalUrl}` 
            });
            
            // Success criteria check
            const hasSuccessUrl = finalUrl.match(/\/checkout\/\d+\/complete/) || 
                                 finalUrl.includes('/complete') || 
                                 finalUrl.includes('/thank-you') || 
                                 finalUrl.includes('/success') || 
                                 finalUrl.includes('/confirmation');
            
            const hasSuccessText = /(Thank you|Registration complete|successfully registered)/i.test(finalContent);
            
            if (hasSuccessUrl || hasSuccessText) {
              await supabase.from("plan_logs").insert({ 
                plan_id, 
                msg: "Worker: Signup completed successfully" 
              });
              
              return { 
                success: true, 
                requiresAction: false,
                details: { message: 'Signup completed successfully' }
              };
            } else {
              break; // Exit state machine to handle as action required
            }
          } catch (error) {
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: `Worker: Payment confirmation timeout: ${error.message}` 
            });
            break; // Exit state machine to handle as action required
          }
        } else {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: No payment button found, breaking state machine" 
          });
          break;
        }
        
      } else if (stateUrl.match(/\/checkout\/\d+\/complete/)) {
        // Complete state: success
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: Signup completed successfully" 
        });
        
        return { 
          success: true, 
          requiresAction: false,
          details: { message: 'Signup completed successfully' }
        };
        
      } else {
        // Unknown state: check for success indicators before breaking
        const content = await page.content().catch(() => '');
        const hasSuccessText = /(Thank you|Registration complete|successfully registered)/i.test(content);
        const hasSuccessUrl = stateUrl.includes('/complete') || 
                             stateUrl.includes('/success') || 
                             stateUrl.includes('/confirmation');
        
        if (hasSuccessText || hasSuccessUrl) {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: Signup completed successfully" 
          });
          
          return { 
            success: true, 
            requiresAction: false,
            details: { message: 'Signup completed successfully' }
          };
        }
        
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: `Worker: Unknown checkout state, breaking state machine. URL: ${stateUrl}` 
        });
        break;
      }
    }
    
    // If we exit the state machine without success, mark as action required
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: "Worker: Signup may not have completed, manual check required" 
    });
    
    return { 
      success: true, 
      requiresAction: true,
      details: { message: 'Signup may not have completed, manual check required' }
    };
    
  } catch (error) {
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: Signup execution error: ${error.message}` 
    });
    
    return { 
      success: false, 
      error: `Signup execution failed: ${error.message}`,
      code: 'SIGNUP_EXECUTION_ERROR'
    };
  }
}

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Worker listening on 0.0.0.0:${PORT}`);
});
