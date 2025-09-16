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

      // Navigate to target page
      const targetUrl = plan.discovered_url || plan.base_url || `https://${subdomain}.skiclubpro.team/dashboard`;
      await supabase.from("plan_logs").insert({ plan_id, msg: `Worker: Opening target page: ${targetUrl}` });
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

      // If no discovered URL, run discovery with Playwright
      if (!plan.discovered_url) {
        await supabase.from("plan_logs").insert({ plan_id, msg: "Worker: Starting discovery..." });
        
        try {
          const discoveredUrls = await discoverSignupUrls(page, plan.child_name);
          
          if (discoveredUrls.length === 0) {
            await supabase.from("plan_logs").insert({ plan_id, msg: "Worker: No signup URLs found for child" });
            return res.status(404).json({ 
              ok: false, 
              code: 'NO_SIGNUP_URLS', 
              msg: 'No matching signup opportunities found for this child' 
            });
          }
          
          // Update the plan with discovered URLs
          const discoveredUrl = discoveredUrls[0];
          await supabase
            .from('plans')
            .update({ discovered_url: discoveredUrl })
            .eq('id', plan_id);
            
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: `Worker: Discovered signup URL: ${discoveredUrl}` 
          });
          
          plan.discovered_url = discoveredUrl;
        } catch (discoveryError) {
          console.error("Discovery error:", discoveryError);
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: `Worker: Discovery failed: ${discoveryError.message}` 
          });
          return res.status(500).json({ 
            ok: false, 
            code: 'DISCOVERY_FAILED', 
            msg: discoveryError.message 
          });
        }
      }

      // Navigate to discovered/target URL
      const finalUrl = plan.discovered_url || targetUrl;
      await supabase.from("plan_logs").insert({ plan_id, msg: `Worker: Navigating to signup: ${finalUrl}` });
      await page.goto(finalUrl, { waitUntil: "domcontentloaded" });

      // Execute the signup
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

// Discover signup URLs
async function discoverSignupUrls(page, childName) {
  const urls = [];
  
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

// Handle Nordic Kids add-on form automation
async function handleNordicAddons(page, plan, supabase) {
  try {
    const plan_id = plan.id;
    
    // Wait a moment for any page transitions
    await page.waitForTimeout(2000);
    
    // Check if we're on a Nordic add-on page
    const content = await page.content().catch(() => '');
    const currentUrl = page.url();
    
    // Look for Nordic-specific indicators
    const isNordicPage = content.toLowerCase().includes('nordic') || 
                        content.includes('add-on') || 
                        content.includes('addon') ||
                        currentUrl.includes('addon') ||
                        currentUrl.includes('add-on');
    
    if (!isNordicPage) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Worker: No Nordic add-on form detected, continuing..." 
      });
      return { success: true };
    }
    
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: "Worker: Nordic add-on form detected, processing..." 
    });
    
    const EXTRAS = (plan?.extras ?? {});
    
    // Handle Rental field - non-blocking
    const rentalValue = EXTRAS.nordicRental;
    const rentalSelectors = [
      'select[name*="rental"], select[id*="rental"]',
      'input[type="radio"][name*="rental"]',
      'input[type="checkbox"][name*="rental"]'
    ];
    
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
      if (rentalValue) {
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: `Worker: Rental field not found, skipping rental selection` 
        });
      } else {
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: No rental field detected, skipping" 
        });
      }
    }
    
    // Handle Color Group field - non-blocking
    const colorGroupValue = EXTRAS.nordicColorGroup;
    const colorGroupSelectors = [
      'select[name*="color"], select[id*="color"]',
      'input[type="radio"][name*="color"]',
      'input[type="checkbox"][name*="color"]'
    ];
    
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
        msg: "Worker: Color group skipped" 
      });
    }
    
    // Handle Volunteer field - non-blocking
    const volunteerValue = EXTRAS.volunteer;
    const volunteerSelectors = [
      'input[type="checkbox"][name*="volunteer"]',
      'input[type="radio"][name*="volunteer"]',
      'select[name*="volunteer"], select[id*="volunteer"]'
    ];
    
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
        msg: "Worker: Volunteer skipped" 
      });
    }
    
    // Handle donation - always skip by filling "0"
    const donationSelectors = [
      'input[name*="donation"], input[id*="donation"]',
      'input[name*="donate"], input[id*="donate"]',
      'input[placeholder*="donation"], input[placeholder*="donate"]'
    ];
    
    for (const selector of donationSelectors) {
      const elements = await page.$$(selector);
      for (const element of elements) {
        const inputType = await element.getAttribute('type');
        if (inputType === 'text' || inputType === 'number' || !inputType) {
          await element.fill('0');
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: Donation skipped (0)" 
          });
          break;
        }
      }
    }
    
    // Look for Next/Continue button - non-blocking
    const nextButtonSelectors = [
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'input[type="submit"][value*="Next"]',
      'input[type="submit"][value*="Continue"]',
      'button[type="submit"]',
      'input[type="submit"]'
    ];
    
    let nextButtonClicked = false;
    for (const selector of nextButtonSelectors) {
      const buttons = await page.$$(selector);
      if (buttons.length > 0) {
        await buttons[0].click();
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: Nordic add-ons completed, clicked Next/Continue" 
        });
        nextButtonClicked = true;
        break;
      }
    }
    
    if (!nextButtonClicked) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Worker: No Next button found, continuing" 
      });
    }
    
    if (nextButtonClicked) {
      await page.waitForTimeout(3000); // Wait for navigation
    }
    
    // After add-ons, check for cart page and handle checkout flow
    const currentUrl = page.url();
    if (currentUrl.includes('/cart')) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Worker: Cart page detected" 
      });
      
      // Click Checkout button
      const checkoutSelectors = [
        'button:has-text("Checkout")',
        '#edit-checkout'
      ];
      
      let checkoutClicked = false;
      for (const selector of checkoutSelectors) {
        const buttons = await page.$$(selector);
        if (buttons.length > 0) {
          await buttons[0].click();
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: Clicked Checkout button" 
          });
          checkoutClicked = true;
          break;
        }
      }
      
      if (checkoutClicked) {
        // Wait for navigation to /checkout/*/installments
        try {
          await page.waitForURL(/\/checkout\/.*\/installments/, { timeout: 30000 });
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: Navigated to installments page" 
          });
          
          // On installments page: ensure saved card radio button is selected
          const savedCardRadios = await page.$$('input[type="radio"]');
          if (savedCardRadios.length > 0) {
            // Select first radio button (saved card)
            const isChecked = await savedCardRadios[0].isChecked();
            if (!isChecked) {
              await savedCardRadios[0].click();
              await supabase.from("plan_logs").insert({ 
                plan_id, 
                msg: "Worker: Selected saved card payment method" 
              });
            }
          }
          
          // Click Continue to Review
          const continueButtons = await page.$$('button:has-text("Continue to Review")');
          if (continueButtons.length > 0) {
            await continueButtons[0].click();
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: "Worker: Clicked Continue to Review" 
            });
            
            // Wait for navigation to /checkout/*/review
            try {
              await page.waitForURL(/\/checkout\/.*\/review/, { timeout: 30000 });
              await supabase.from("plan_logs").insert({ 
                plan_id, 
                msg: "Worker: Navigated to review page" 
              });
              
              // On review page: click Pay and complete purchase
              const payButtons = await page.$$('button:has-text("Pay and complete purchase")');
              if (payButtons.length > 0) {
                await payButtons[0].click();
                await supabase.from("plan_logs").insert({ 
                  plan_id, 
                  msg: "Worker: Clicked Pay and complete purchase" 
                });
                
                // Wait for confirmation URL or text
                try {
                  // Wait for confirmation page or success text
                  await Promise.race([
                    page.waitForURL(/\/(complete|thank-you)/, { timeout: 30000 }),
                    page.waitForSelector('text="Thank you"', { timeout: 30000 }),
                    page.waitForSelector('text="Registration complete"', { timeout: 30000 }),
                    page.waitForSelector('text="success"', { timeout: 30000 })
                  ]);
                  
                  await supabase.from("plan_logs").insert({ 
                    plan_id, 
                    msg: "Worker: Payment confirmed" 
                  });
                  
                  // Update plan status to completed
                  await supabase
                    .from('plans')
                    .update({ 
                      status: 'completed',
                      completed_at: new Date().toISOString()
                    })
                    .eq('id', plan_id);
                  
                } catch (confirmError) {
                  await supabase.from("plan_logs").insert({ 
                    plan_id, 
                    msg: "Worker: Signup may not have completed, manual check required" 
                  });
                  
                  // Set status to action_required
                  await supabase
                    .from('plans')
                    .update({ status: 'action_required' })
                    .eq('id', plan_id);
                }
              }
            } catch (reviewError) {
              await supabase.from("plan_logs").insert({ 
                plan_id, 
                msg: "Worker: Failed to navigate to review page" 
              });
            }
          }
        } catch (installmentsError) {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: Failed to navigate to installments page" 
          });
        }
      }
    }
    
    // Always return success to ensure non-blocking execution
    return { success: true };
    
  } catch (error) {
    await supabase.from("plan_logs").insert({ 
      plan_id: plan.id, 
      msg: `Worker: Nordic add-on error (non-blocking): ${error.message}` 
    });
    // Even on error, return success to continue execution
    return { success: true };
  }
}

async function executeSignup(page, plan, credentials, supabase) {
  try {
    const plan_id = plan.id;
    
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: "Worker: Starting signup process..." 
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
      msg: "Worker: Filling signup form..." 
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
          msg: "Worker: CVV entered for payment" 
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
        msg: "Worker: Signup form submitted" 
      });
    }
    
    // Check for Nordic Kids add-on form after initial signup
    const nordicResult = await handleNordicAddons(page, plan, supabase);
    if (!nordicResult.success) {
      return nordicResult;
    }
    
    // Handle payment with saved card + CVV
    const paymentResult = await handleBlackhawkPayment(page, plan, credentials, supabase);
    if (!paymentResult.success) {
      return paymentResult;
    }
    
    // Check for final success criteria
    const content = await page.content().catch(() => '');
    const currentUrl = page.url();
    
    // Only log success if confirmation page/URL is detected
    const confirmationIndicators = [
      'thank you', 'registration complete', 'success', 'confirmed', 'receipt'
    ];
    
    const hasConfirmation = confirmationIndicators.some(indicator => 
      content.toLowerCase().includes(indicator)
    ) || currentUrl.includes('success') || currentUrl.includes('complete') || currentUrl.includes('confirmation');
    
    if (hasConfirmation) {
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
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Worker: Signup may not have completed, manual check required" 
      });
      
      // Update plan status to action_required
      await supabase
        .from('plans')
        .update({ status: 'action_required' })
        .eq('id', plan_id);
      
      return { 
        success: true, 
        requiresAction: true,
        details: { message: 'Signup may not have completed, manual check required' }
      };
    }
    
  } catch (error) {
    return { 
      success: false, 
      error: `Signup execution failed: ${error.message}`,
      code: 'SIGNUP_EXECUTION_ERROR'
    };
  }
}

// Handle Blackhawk payment flow with CVV
async function handleBlackhawkPayment(page, plan, credentials, supabase) {
  try {
    const plan_id = plan.id;
    const EXTRAS = (plan?.extras ?? {});
    const allowNoCvv = (EXTRAS.allow_no_cvv === true || EXTRAS.allow_no_cvv === 'true' || plan.allow_no_cvv === true);
    
    // Wait a moment for any page transitions
    await page.waitForTimeout(2000);
    
    // Check if we're on a payment/checkout page
    const content = await page.content().catch(() => '');
    const currentUrl = page.url();
    
    const isPaymentPage = content.toLowerCase().includes('payment') || 
                         content.toLowerCase().includes('checkout') ||
                         content.toLowerCase().includes('billing') ||
                         currentUrl.includes('payment') ||
                         currentUrl.includes('checkout') ||
                         currentUrl.includes('billing');
    
    if (!isPaymentPage) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Worker: No payment page detected, continuing..." 
      });
      return { success: true };
    }
    
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: "Worker: Payment page detected, processing..." 
    });
    
    // Look for CVV field and fill if exists
    const cvvSelectors = [
      'input[name*="cvv"]',
      'input[id*="cvv"]',
      'input[name*="security"]',
      'input[id*="security"]',
      'input[placeholder*="CVV"]',
      'input[placeholder*="Security"]',
      'input[placeholder*="CVC"]',
      'input[name*="cvc"]',
      'input[id*="cvc"]'
    ];
    
    let cvvField = null;
    for (const selector of cvvSelectors) {
      const fields = await page.$$(selector);
      if (fields.length > 0) {
        cvvField = fields[0];
        break;
      }
    }
    
    if (cvvField && credentials.cvv) {
      await cvvField.fill(String(credentials.cvv));
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Worker: CVV entered for payment" 
      });
    }
    
    // Click Pay/Complete/Submit button
    const paymentButtonSelectors = [
      'button:has-text("Pay")',
      'button:has-text("Complete")',
      'button:has-text("Submit")',
      'button:has-text("Place Order")',
      'button:has-text("Confirm")',
      'input[type="submit"][value*="Pay"]',
      'input[type="submit"][value*="Complete"]',
      'input[type="submit"][value*="Submit"]',
      'button[type="submit"]',
      'input[type="submit"]'
    ];
    
    let paymentButtonClicked = false;
    for (const selector of paymentButtonSelectors) {
      const buttons = await page.$$(selector);
      if (buttons.length > 0) {
        await buttons[0].click();
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: Payment button clicked" 
        });
        paymentButtonClicked = true;
        break;
      }
    }
    
    if (paymentButtonClicked) {
      // Wait for confirmation page or success indicators
      await page.waitForTimeout(10000);
      
      const updatedContent = await page.content().catch(() => '');
      const updatedUrl = page.url();
      
      // Check for confirmation page
      const confirmationIndicators = [
        'thank you', 'registration complete', 'success', 'confirmed', 'receipt'
      ];
      
      const hasConfirmation = confirmationIndicators.some(indicator => 
        updatedContent.toLowerCase().includes(indicator)
      ) || updatedUrl.includes('success') || updatedUrl.includes('complete') || updatedUrl.includes('confirmation');
      
      if (hasConfirmation) {
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: Payment and registration completed successfully" 
        });
        
        return { 
          success: true,
          requiresAction: false,
          details: { message: 'Payment and registration completed successfully' }
        };
      }
    }
    
    return { success: true };
    
  } catch (error) {
    await supabase.from("plan_logs").insert({ 
      plan_id: plan.id, 
      msg: `Worker: Payment processing error: ${error.message}` 
    });
    
    // Update plan status to failed on error
    await supabase
      .from('plans')
      .update({ status: 'failed' })
      .eq('id', plan.id);
    
    return { 
      success: false, 
      error: `Payment processing failed: ${error.message}`,
      code: 'PAYMENT_PROCESSING_ERROR'
    };
  }
}

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Worker listening on 0.0.0.0:${PORT}`);
});
