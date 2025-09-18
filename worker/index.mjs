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

// ===== SHARED REGISTER SELECTORS =====
const REGISTER_SELECTORS = [
  'button:has-text("Register")',
  'a:has-text("Register")',
  'input[type="submit"][value*="Register" i]',
  '[value*="Register" i]',
  // friendly synonyms some clubs use:
  'button:has-text("Enroll")',
  'a:has-text("Enroll")'
];

// ===== FUZZY MATCHING UTILITY =====
function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1.0;
  
  const len1 = s1.length;
  const len2 = s2.length;
  
  if (len1 === 0 || len2 === 0) return 0.0;
  
  const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
  if (matchWindow < 0) return 0.0;
  
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);
  
  let matches = 0;
  let transpositions = 0;
  
  // Identify matches
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, len2);
    
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = s2Matches[j] = true;
      matches++;
      break;
    }
  }
  
  if (matches === 0) return 0.0;
  
  // Count transpositions
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  
  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3.0;
  
  // Calculate common prefix length (up to 4 characters)
  let prefix = 0;
  for (let i = 0; i < Math.min(len1, len2, 4); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  
  return jaro + (0.1 * prefix * (1.0 - jaro));
}

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

    // ===== AES-GCM CRYPTO HELPERS =====
    async function importKey() {
      const keyBytes = Uint8Array.from(atob(CRED_ENC_KEY), c => c.charCodeAt(0));
      return await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt','decrypt']);
    }

    async function aesEncrypt(obj) {
      const key = await importKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
      return { iv: Array.from(iv), ct: Array.from(ct) };
    }

    async function aesDecrypt(payload) {
      const key = await importKey();
      const iv = new Uint8Array(payload.iv);
      const ct = new Uint8Array(payload.ct);
      const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, ct);
      return JSON.parse(new TextDecoder().decode(pt));
    }

    // ===== SESSION STATE SAVE/RESTORE =====
    async function saveSessionState(page, plan, supabase) {
      try {
        const cookies = await page.context().cookies();
        const storage = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }));
        const payload = await aesEncrypt({ cookies, storage, user_id: plan.user_id, plan_id: plan.id });
        await supabase.from('session_states').insert({
          plan_id: plan.id, user_id: plan.user_id,
          cookies: payload, storage: { stub: true },  // payload contains both; storage column kept for schema symmetry
          expires_at: new Date(Date.now() + 24*60*60*1000).toISOString()
        });
        await supabase.from('plan_logs').insert({ plan_id: plan.id, msg: 'Worker: Session state saved' });
      } catch (e) {
        await supabase.from('plan_logs').insert({ plan_id: plan.id, msg: `Worker: Session save error: ${e.message}` });
      }
    }

    async function restoreSessionState(page, plan, supabase) {
      try {
        const { data, error } = await supabase
          .from('session_states')
          .select('cookies, created_at, expires_at')
          .eq('plan_id', plan.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error || !data) return false;
        if (data.expires_at && Date.now() > Date.parse(data.expires_at)) return false;

        const restored = await aesDecrypt(data.cookies);
        if (restored.cookies?.length) await page.context().addCookies(restored.cookies);
        if (restored.storage) {
          await page.goto(plan.base_url || `https://${(plan.org||'').toLowerCase().replace(/[^a-z0-9]/g,'')}.skiclubpro.team`, { waitUntil:'domcontentloaded' });
          await page.evaluate(s => {
            try {
              const parsed = typeof s === 'string' ? JSON.parse(s) : s;
              const { local, session } = parsed.storage || parsed;
              if (local) { const l = JSON.parse(local); Object.keys(l).forEach(k => localStorage.setItem(k, l[k])); }
              if (session) { const se = JSON.parse(session); Object.keys(se).forEach(k => sessionStorage.setItem(k, se[k])); }
            } catch {}
          }, JSON.stringify(restored));
        }
        await supabase.from('plan_logs').insert({ plan_id: plan.id, msg: 'Worker: Session state restored' });
        return true;
      } catch (e) {
        await supabase.from('plan_logs').insert({ plan_id: plan.id, msg: `Worker: Session restore error: ${e.message}` });
        return false;
      }
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

        // Session seeding to bypass antibot detection with timing calibration
        await seedBrowserSessionWithTiming(page, plan, plan_id, supabase);
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

      // Restore session state before attempting login
      await restoreSessionState(page, plan, supabase);
      
      // Navigate to base origin and check if already logged in
      await supabase.from("plan_logs").insert({ plan_id, msg: "Worker: Checking login status..." });
      await page.goto(normalizedBaseUrl, { waitUntil: 'domcontentloaded' });
      
      const content = (await page.content()).toLowerCase();
      const url = page.url();
      const loggedIn = url.includes('dashboard') || content.includes('logout') || content.includes('sign out');
      
      if (loggedIn) {
        await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: Already logged in (restored session)' });
      } else {
        // Proceed with existing login flow
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
      }

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

// Seed-plan endpoint - performs session seeding only
app.post("/seed-plan", async (req, res) => {
  const plan_id = req.body?.plan_id || "unknown";
  console.log(`🌱 /seed-plan request for plan_id: ${plan_id}`);

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

    console.log(`Starting session seeding for plan_id: ${plan_id}`);

    // Log the start of seeding
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Worker: Session seeding started - loading plan details...'
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

        await supabase.from("plan_logs").insert({ plan_id, msg: "Worker: Playwright connected for seeding" });

        // Perform session seeding
        const seedResult = await seedBrowserSession(page, plan, supabase);
        
        if (seedResult) {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: Session seeding completed successfully" 
          });
        } else {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: Session seeding completed with warnings" 
          });
        }

        res.json({ 
          ok: true, 
          msg: 'Session seeding completed',
          sessionId: session.id,
          plan_id
        });

      } catch (e) {
        console.error("Playwright connect error:", e);
        await supabase.from("plan_logs").insert({
          plan_id,
          msg: "Worker: PLAYWRIGHT_CONNECT_FAILED: " + (e?.message ?? String(e))
        });
        return res.status(500).json({ ok:false, code:"PLAYWRIGHT_CONNECT_FAILED", msg:"Cannot connect Playwright" });
      }

    } catch (error) {
      console.error("Seeding error:", error);
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Worker: Seeding error: ${error.message}` 
      });

      res.status(500).json({ 
        ok: false, 
        code: 'SEEDING_ERROR', 
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
            msg: "Worker: Browserbase session closed after seeding" 
          });
        } catch (e) {
          console.error("Error closing Browserbase session:", e);
        }
      }
    }
  } catch (error) {
    console.error("❌ Worker error in /seed-plan:", error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// Session seeding with timing calibration to bypass antibot detection  
async function seedBrowserSessionWithTiming(page, plan, plan_id, supabase) {
  try {
    // Parse open_time and calculate optimal timing
    const openTime = new Date(plan.open_time);
    const currentTime = new Date();
    
    // Session seeding takes approximately 1-3 minutes
    // Start seeding 4 minutes before open_time to ensure completion before action
    const SEEDING_DURATION_MS = 3 * 60 * 1000; // 3 minutes buffer
    const seedingStartTime = new Date(openTime.getTime() - SEEDING_DURATION_MS);
    
    await supabase.from("plan_logs").insert({
      plan_id, 
      msg: `Worker: Timing calibration - Open: ${openTime.toISOString()}, Seeding start: ${seedingStartTime.toISOString()}, Current: ${currentTime.toISOString()}`
    });

    // If we're before seeding time, wait
    if (currentTime < seedingStartTime) {
      const waitTime = seedingStartTime.getTime() - currentTime.getTime();
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: `Worker: Waiting ${Math.round(waitTime/1000)}s until seeding start time (${seedingStartTime.toISOString()})`
      });
      
      // Wait until seeding start time
      await new Promise(resolve => setTimeout(resolve, waitTime));
      
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: "Worker: Starting session seeding at optimal time"
      });
    } else {
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: "Worker: Starting session seeding immediately (past optimal start time)"
      });
    }

    // Perform the actual session seeding (non-blocking)
    try {
      await seedBrowserSession(page, plan, supabase);
    } catch (seedError) {
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: `Worker: Session seeding failed but continuing: ${seedError.message}`
      });
    }
    
    // After seeding, wait until 30 seconds before open_time to start signup
    const signupStartTime = new Date(openTime.getTime() - 30 * 1000); // 30s before open
    const nowAfterSeeding = new Date();
    
    if (nowAfterSeeding < signupStartTime) {
      const finalWaitTime = signupStartTime.getTime() - nowAfterSeeding.getTime();
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: `Worker: Seeding complete. Waiting ${Math.round(finalWaitTime/1000)}s until signup time (${signupStartTime.toISOString()})`
      });
      
      await new Promise(resolve => setTimeout(resolve, finalWaitTime));
    }
    
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: Session seeding and timing calibration complete - ready for signup"
    });

  } catch (error) {
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: `Worker: Timing calibration error (continuing): ${error.message}`
    });
    // Continue with immediate seeding as fallback (non-blocking)
    try {
      await seedBrowserSession(page, plan, supabase);
    } catch (seedError) {
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: `Worker: Fallback session seeding failed but continuing: ${seedError.message}`
      });
    }
  }
}

// Session seeding to bypass antibot detection
async function seedBrowserSession(page, plan, supabase, opts={}) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const jitter = (a,b)=> a + Math.random()*(b-a);
  try {
    await supabase.from('plan_logs').insert({ plan_id: plan.id, msg: 'Worker: Starting browser session seeding' });
    
    // Home
    const base = plan.base_url ? new URL(plan.base_url).origin :
      `https://${(plan.org||'').toLowerCase().replace(/[^a-z0-9]/g,'')}.skiclubpro.team`;
    await page.goto(base, { waitUntil:'networkidle' });
    await page.mouse.move(120, 220, { steps: 12 }); 
    await sleep(jitter(15000,30000));
    
    await supabase.from('plan_logs').insert({ plan_id: plan.id, msg: 'Worker: Explored homepage, moving to registration pages' });
    
    // Explore 1-2 pages
    const anchors = await page.locator('a[href*="/registration"]').all();
    for (let i=0;i<Math.min(2,anchors.length);i++) {
      const href = await anchors[i].getAttribute('href'); 
      if (!href) continue;
      await page.goto(new URL(href, base).toString(), { waitUntil:'networkidle' });
      await page.mouse.move(180+i*40, 320, { steps: 10 }); 
      await sleep(jitter(12000,25000));
    }
    
    await supabase.from('plan_logs').insert({ plan_id: plan.id, msg: 'Worker: Explored registration pages, viewing target program' });
    
    // Target view (no register click)
    const tx = `${plan.preferred_class_name||''} ${plan.preferred||''}`.trim();
    if (tx) {
      const title = page.locator(`text=${tx}`).first();
      if (await title.count()) { 
        await title.scrollIntoViewIfNeeded(); 
        await sleep(jitter(6000,12000)); 
      }
    }
    
    await supabase.from('plan_logs').insert({ plan_id: plan.id, msg: 'Worker: Session seeding completed' });
    
    // Save state
    await saveSessionState(page, plan, supabase);
    return true;
  } catch (e) {
    await supabase.from('plan_logs').insert({ plan_id: plan.id, msg: `Worker: Seeding error: ${e.message}` });
    return false;
  }
}

// Session seeding to bypass antibot detection
async function seedBrowserSession(page, plan, plan_id, supabase) {
  try {
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: Starting session seeding to bypass antibot detection"
    });

    // Normalize base URL
    let baseUrl;
    if (plan.base_url) {
      try {
        const url = new URL(plan.base_url);
        baseUrl = `${url.protocol}//${url.host}`;
      } catch {
        const subdomain = (plan.org || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        baseUrl = `https://${subdomain}.skiclubpro.team`;
      }
    } else {
      const subdomain = (plan.org || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      baseUrl = `https://${subdomain}.skiclubpro.team`;
    }

    // Phase 1: Homepage exploration
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: Seeding Phase 1 - Homepage exploration"
    });
    
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await humanizedDelay(2000, 4000);
    
    // Human-like homepage interactions
    await simulateMouseMovement(page);
    await humanizedScroll(page, plan_id, supabase);
    await humanizedDelay(15000, 25000); // Dwell time 15-25 seconds

    // Phase 2: Program discovery
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: Seeding Phase 2 - Program discovery"
    });

    // Try to find and visit programs page
    const programsSelectors = [
      'a[href*="programs"]',
      'a[href*="registration"]', 
      'a[href*="classes"]',
      'a:has-text("Programs")',
      'a:has-text("Classes")',
      'a:has-text("Registration")'
    ];

    let programsFound = false;
    for (const selector of programsSelectors) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible()) {
          await simulateMouseMovement(page, element);
          await humanizedDelay(1000, 2000);
          await element.click();
          programsFound = true;
          await humanizedDelay(3000, 5000);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    if (programsFound) {
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: "Worker: Found programs page, exploring content"
      });
      
      // Explore programs page
      await humanizedScroll(page, plan_id, supabase);
      await simulateReadingBehavior(page);
      await humanizedDelay(20000, 30000); // Longer dwell time on programs page
    }

    // Phase 3: Target program interest
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: Seeding Phase 3 - Target program interest simulation"
    });

    // Look for target program elements (without clicking register)
    const targetKeywords = [
      plan.preferred_class_name,
      plan.child_name,
      plan.preferred?.split(' ')[0], // Day of week
      'Nordic', 'Kids'
    ].filter(Boolean);

    for (const keyword of targetKeywords) {
      try {
        const elements = await page.locator(`text="${keyword}"`).all();
        if (elements.length > 0) {
          // Simulate interest by hovering over target program elements
          for (let i = 0; i < Math.min(elements.length, 3); i++) {
            await simulateMouseMovement(page, elements[i]);
            await humanizedDelay(2000, 4000);
          }
          break;
        }
      } catch (e) {
        // Continue with next keyword
      }
    }

    // Phase 4: Decision pause and preparation
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: Seeding Phase 4 - Decision pause before action"
    });

    // Final scroll and mouse movements to simulate decision-making
    await humanizedScroll(page, plan_id, supabase);
    await simulateMouseMovement(page);
    await humanizedDelay(10000, 15000); // Decision pause

    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: Session seeding completed successfully"
    });

  } catch (error) {
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: `Worker: Session seeding error (continuing): ${error.message}`
    });
    // Don't fail the entire process if seeding fails
  }
}

// Simulate natural mouse movement patterns
async function simulateMouseMovement(page, targetElement = null) {
  try {
    if (targetElement) {
      // Move to specific element with natural curve
      await targetElement.hover();
    } else {
      // Random mouse movements across the page
      const viewport = page.viewportSize();
      const movements = Math.floor(Math.random() * 3) + 2; // 2-4 movements
      
      for (let i = 0; i < movements; i++) {
        const x = Math.floor(Math.random() * viewport.width * 0.8) + viewport.width * 0.1;
        const y = Math.floor(Math.random() * viewport.height * 0.8) + viewport.height * 0.1;
        
        await page.mouse.move(x, y);
        await humanizedDelay(500, 1500);
      }
    }
  } catch (e) {
    // Ignore mouse movement errors
  }
}

// Simulate reading behavior with pauses
async function simulateReadingBehavior(page) {
  try {
    // Look for text-heavy elements and simulate reading
    const textElements = await page.locator('p, div, li').all();
    const readableElements = textElements.slice(0, 5); // Read first 5 elements
    
    for (const element of readableElements) {
      try {
        if (await element.isVisible()) {
          await element.scrollIntoViewIfNeeded();
          await simulateMouseMovement(page, element);
          
          // Simulate reading time based on text length
          const text = await element.textContent();
          const readingTime = Math.min(text?.length || 0 * 50, 8000); // Max 8 seconds
          await humanizedDelay(readingTime, readingTime + 2000);
        }
      } catch (e) {
        // Continue with next element
      }
    }
  } catch (e) {
    // Ignore reading simulation errors
  }
}

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

// Blackhawk-specific discovery: Find and click Register using multiple strategies
async function discoverBlackhawkRegistration(page, plan, supabase) {
  const plan_id = plan.id;
  const baseUrl = page.url().split('/').slice(0, 3).join('/');
  
  try {
    // Strategy 3: Direct Program ID (fast path)
    if (plan.program_id) {
      const directUrl = `${baseUrl}/registration/${plan.program_id}/start`;
      
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Worker: Navigated directly to program ID ${plan.program_id}` 
      });
      
      await page.goto(directUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      
      // Verify we're on a valid start page
      const currentUrl = page.url();
      if (currentUrl.includes('/registration/') && currentUrl.includes('/start')) {
        return { success: true, startUrl: currentUrl };
      }
    }
    
    // Strategy 1: Program Name Discovery
    const registrationUrls = [`${baseUrl}/registration`, `${baseUrl}/registration/events`];
    
    for (const registrationUrl of registrationUrls) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Worker: Trying program name discovery at: ${registrationUrl}` 
      });
      
      await page.goto(registrationUrl, { waitUntil: "domcontentloaded" });
      
      try {
        // Build targetText from preferred_class_name and preferred
        const rawName = plan.preferred_class_name || "";
        const dayPart = plan.preferred || "";
        let targetText = [rawName, dayPart].filter(Boolean).join(" ").trim();

        // Remove accidental duplicates like "Wednesday Wednesday"
        targetText = targetText.replace(/\b(\w+)\s+\1\b/g, "$1");
        
        // Strip trailing time parts like "at 16:30" if both day+time already present
        targetText = targetText.replace(/\s+at\s+\d{1,2}:\d{2}(\s*(AM|PM))?$/i, "");
        
        // Fallback if empty
        if (!targetText) {
          targetText = "Nordic Kids Wednesday";
        }
        
        await supabase.from("plan_logs").insert({
          plan_id,
          msg: `Worker: Using targetText "${targetText}" for program discovery`
        });
        
        // Wait for any program row to appear
        await page.waitForSelector('.views-row, tr', { timeout: 15000 });
        await supabase.from("plan_logs").insert({
          plan_id,
          msg: "Worker: Program rows detected on registration page"
        });

        // Immediately log visible program rows
        try {
          const rows = await page.locator('.views-row, tr').allTextContents();
          await supabase.from("plan_logs").insert({
            plan_id,
            msg: `Worker: Visible rows: ${JSON.stringify(rows.slice(0, 10))}`
          });
        } catch (e) {
          await supabase.from("plan_logs").insert({
            plan_id,
            msg: `Worker: Could not extract rows: ${e.message}`
          });
        }
        
        await supabase.from("plan_logs").insert({
          plan_id,
          msg: `Worker: Searching for program row with text "${targetText}"`
        });
        
        let clicked = false;
        
        // Scope Register button search to the container row
        try {
          const row = page.locator(`text=${targetText}`).first()
            .locator('xpath=ancestor::tr[1]').first();

          for (const sel of REGISTER_SELECTORS) {
            const btn = row.locator(sel).first();
            if (await btn.count()) {
              await btn.scrollIntoViewIfNeeded();
              await btn.click();
              clicked = true;
              await supabase.from("plan_logs").insert({
                plan_id,
                msg: `Worker: Register clicked for "${targetText}" via ${sel}`
              });
              break;
            }
          }

          // Fallback 1: Direct link inside the same row
          if (!clicked) {
            const link = row.locator('a[href*="/registration/"][href*="/start"]').first();
            if (await link.count()) {
              await link.click();
              clicked = true;
              await supabase.from("plan_logs").insert({
                plan_id,
                msg: `Worker: Register clicked via direct href for ${targetText}`
              });
            }
          }
        } catch (e) {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: `Worker: Direct row search failed: ${e.message}` 
          });
        }

        // Fallback 2: Fuzzy matching across all rows if still not found
        if (!clicked) {
          try {
            // Extract all row texts using the simpler allTextContents method
            const rows = await page.locator('.views-row, tr').allTextContents();
            const validRows = rows.filter(text => text && text.trim());
            
            if (validRows.length === 0) {
              await supabase.from("plan_logs").insert({
                plan_id,
                msg: `Worker: No rows found for fuzzy matching`
              });
            } else {
              // Compute Jaro-Winkler similarity with targetText
              const scores = validRows.map((text, index) => ({
                text: text.trim(),
                index,
                score: jaroWinkler(text.trim().toLowerCase(), targetText.toLowerCase())
              }));
              
              // Sort by score descending and pick best ≥ 0.8
              scores.sort((a, b) => b.score - a.score);
              const best = scores[0];
              
              await supabase.from("plan_logs").insert({
                plan_id,
                msg: `Worker: Fuzzy match candidate: "${best.text.substring(0, 100)}" (score ${best.score.toFixed(2)})`
              });
              
              if (best.score >= 0.8) {
                // Get the actual row element by index and attempt register click
                const rowElement = page.locator('.views-row, tr').nth(best.index);
                let registerFound = false;
                
                for (const sel of REGISTER_SELECTORS) {
                  const btn = rowElement.locator(sel).first();
                  if (await btn.count()) {
                    await btn.scrollIntoViewIfNeeded();
                    await btn.click();
                    clicked = true;
                    registerFound = true;
                    await supabase.from("plan_logs").insert({
                      plan_id,
                      msg: `Worker: Register clicked for fuzzy match "${best.text.substring(0, 50)}" via ${sel}`
                    });
                    break;
                  }
                }
                
                if (!registerFound) {
                  await supabase.from("plan_logs").insert({
                    plan_id,
                    msg: `Worker: Fuzzy match found but no register button in row`
                  });
                }
              } else {
                await supabase.from("plan_logs").insert({
                  plan_id,
                  msg: `Worker: Best fuzzy match score ${best.score.toFixed(2)} below threshold 0.8`
                });
              }
            }
          } catch (e) {
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: `Worker: Fuzzy matching failed: ${e.message}` 
            });
          }
        }

        // Partial/fallback matching if exact text fails
        if (!clicked) {
          const fallbackTitle = page.locator('text=Nordic Kids').first();
          if (await fallbackTitle.count()) {
            await supabase.from("plan_logs").insert({
              plan_id,
              msg: `Worker: Fallback search matched "Nordic Kids"`
            });
            const fallbackRow = fallbackTitle.locator('xpath=ancestor::tr[1]').first();
            const fallbackBtn = fallbackRow.locator(REGISTER_SELECTORS.join(',')).first();
            if (await fallbackBtn.count()) {
              await fallbackBtn.click();
              clicked = true;
              await supabase.from("plan_logs").insert({
                plan_id,
                msg: `Worker: Register clicked via fallback container`
              });
            }
          }
        }

        // Fallback 3: Global click attempt as last resort
        if (!clicked) {
          await supabase.from("plan_logs").insert({
            plan_id,
            msg: `Worker: No Register found for "${targetText}" — falling back to global search`
          });
          
          clicked = await reliableClick(page, REGISTER_SELECTORS, plan_id, supabase, "Register (global fallback)");
          if (clicked) {
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: `Worker: Register clicked via global fallback for "${targetText}"` 
            });
          }
        }

        // Logging when discovery fails entirely
        if (!clicked) {
          try {
            const rows = await page.locator('.views-row, tr').allTextContents();
            const visibleRows = rows.filter(row => row && row.trim()).slice(0, 10);
            await supabase.from("plan_logs").insert({
              plan_id,
              msg: `Worker: Visible rows: ${JSON.stringify(visibleRows)}`
            });
          } catch (e) {
            await supabase.from("plan_logs").insert({
              plan_id,
              msg: `Worker: Could not extract program rows: ${e.message}`
            });
          }
          
          const html = await page.content();
          await supabase.from("plan_logs").insert({
            plan_id,
            msg: `Worker: Program discovery failed. Tried target "${targetText}". DOM snippet: ${html.slice(0,500)}`
          });
        } else {
          // Wait for navigation to start page
          await page.waitForURL(/\/registration\/.*\/start/, { timeout: 30000 });
          return { success: true, startUrl: page.url() };
        }
      } catch (error) {
        // Continue to next strategy
        console.log(`Program name strategy failed: ${error.message}`);
      }
    }
    
    // Strategy 2: Session Time (fallback)
    if (plan.session_time || plan.time) {
      const sessionTime = plan.session_time || plan.time;
      
      for (const registrationUrl of registrationUrls) {
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: `Worker: Trying session time discovery for: ${sessionTime}` 
        });
        
        await page.goto(registrationUrl, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
        
        try {
          // Use shared REGISTER_SELECTORS for time-based discovery
          const clicked = await reliableClick(page, REGISTER_SELECTORS, plan_id, supabase, "Register (time-based)");
          
          if (clicked) {
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: "Worker: Program found by time" 
            });
            
            // Wait for navigation to start page
            await page.waitForURL(/\/registration\/.*\/start/, { timeout: 30000 });
            return { success: true, startUrl: page.url() };
          }
        } catch (error) {
          // Continue to failure
          console.log(`Session time strategy failed: ${error.message}`);
        }
      }
    }
    
    // All strategies failed - log attempted selectors and DOM snippet
    try {
      const html = await page.content();
      const snippet = html.slice(0, 500);
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker: No Register/Enroll control found. Tried: ${REGISTER_SELECTORS.join(', ')}. Snippet: ${snippet}`
      });
    } catch (e) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Worker: Program discovery failed. Tried selectors: ${REGISTER_SELECTORS.join(', ')}`
      });
    }
    
    return { 
      success: false, 
      error: "All discovery strategies failed - program not found by name, time, or direct ID" 
    };
    
  } catch (error) {
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: Blackhawk registration discovery error: ${error.message}` 
    });
    
    return { 
      success: false, 
      error: `Blackhawk registration discovery failed: ${error.message}` 
    };
  }
}

// Universal scrolling helper - scrolls until element is visible
async function scrollUntilVisible(page, selector, maxScrolls = 15) {
  for (let scrollAttempt = 1; scrollAttempt <= maxScrolls; scrollAttempt++) {
    const locator = page.locator(selector).first();
    
    try {
      // Check if element is visible
      if (await locator.isVisible()) {
        return locator;
      }
    } catch (error) {
      // Element might not exist yet, continue scrolling
    }
    
    console.log(`Scroll attempt ${scrollAttempt}: element not visible yet`);
    
    // Scroll down and wait
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(500);
  }
  
  throw new Error(`Element ${selector} not found after ${maxScrolls} scroll attempts`);
}

// Human-like behavior helpers
function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanizedDelay(minMs, maxMs) {
  const baseDelay = getRandomDelay(minMs, maxMs);
  const jitter = getRandomDelay(-100, 200); // Add ±200ms jitter
  await new Promise(resolve => setTimeout(resolve, Math.max(100, baseDelay + jitter)));
}

async function humanizedMouseMove(page, locator) {
  try {
    const box = await locator.boundingBox();
    if (box) {
      // Move to target in 20 steps for natural movement
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
      // Hover for 300-800ms
      await humanizedDelay(300, 800);
    }
  } catch (error) {
    // If mouse movement fails, continue without it
    console.log('Mouse movement failed:', error.message);
  }
}

async function humanizedScroll(page, plan_id, supabase) {
  try {
    const scrollAmount = getRandomDelay(200, 600);
    await page.evaluate((amount) => {
      window.scrollBy(0, amount);
    }, scrollAmount);
    
    // Pause between scrolls
    await humanizedDelay(200, 600);
    
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: Human-like scroll (${scrollAmount}px)` 
    });
  } catch (error) {
    console.log('Scroll failed:', error.message);
  }
}

async function humanizedType(locator, text) {
  try {
    await locator.click();
    await locator.clear();
    
    // Type character by character with natural delays
    for (const char of text) {
      await locator.type(char);
      const delay = getRandomDelay(80, 150) + getRandomDelay(-20, 30); // 80-150ms ± jitter
      await new Promise(resolve => setTimeout(resolve, Math.max(50, delay)));
    }
  } catch (error) {
    // Fallback to regular fill if typing fails
    await locator.fill(text);
  }
}

// Reliable button click helper with human-like behavior
async function reliableClick(page, selectors, plan_id, supabase, actionName) {
  const maxRetries = 3;
  const retryDelay = 500;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    for (const selector of selectors) {
      try {
        // Use scrollUntilVisible to find the element
        const locator = await scrollUntilVisible(page, selector, 15);
        
        // Human-like mouse movement and hover
        await humanizedMouseMove(page, locator);
        
        // Random delay before click (100-300ms)
        await humanizedDelay(100, 300);
        
        // Click the element
        await locator.click();
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: `Worker: Successfully clicked ${actionName} button (${selector}) with human-like behavior` 
        });
        return true;
        
      } catch (error) {
        // Continue to next selector or retry
        console.log(`Failed to find/click ${selector}: ${error.message}`);
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
    msg: `Worker: Current URL: ${currentUrl}` 
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
      '#edit-submit',
      'button#edit-submit',
      'button:has-text("Next")',
      'input[type="submit"][value*="Next"]'
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
  
  // Always return success to ensure non-blocking execution - handleNordicAddons never sets final status
  return { success: true };
}

async function executeSignup(page, plan, credentials, supabase) {
  try {
    const plan_id = plan.id;
    
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: "Worker: Starting Blackhawk multi-step signup process with human-like behavior..." 
    });
    
    // Step 1: Discovery & Register - Navigate to /registration and click Register button
    const discoveryResult = await discoverBlackhawkRegistration(page, plan, supabase);
    if (!discoveryResult.success) {
      return { 
        success: false, 
        error: discoveryResult.error,
        code: 'BLACKHAWK_DISCOVERY_FAILED'
      };
    }
    
    // Human-like delay after discovery navigation
    await humanizedDelay(2000, 4000);
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: "Worker: Post-discovery human delay completed" 
    });
    
    // Step 2: Start Page (/registration/*/start) - Select participant from dropdown
    let currentUrl = page.url();
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: Current URL: ${currentUrl}` 
    });
    
    if (currentUrl.match(/\/registration\/.*\/start/)) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Worker: On start page, selecting participant..." 
      });
      
      // Human-like scroll on long pages
      await humanizedScroll(page, plan_id, supabase);
      
      // Look for participant dropdown and select matching child
      const participantSelectors = [
        'select[name*="participant"]',
        'select[id*="participant"]',
        'select[name*="child"]',
        'select[id*="child"]',
        'select'
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
                msg: `Worker: Participant selected: ${plan.child_name}` 
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
              msg: `Worker: Participant selected: ${firstOption}` 
            });
            participantSelected = true;
          }
          
          if (participantSelected) break;
        }
      }
      
      // Click Next button using robust selectors
      const nextSelectors = [
        '#edit-submit',
        'button#edit-submit',
        'button:has-text("Next")',
        'input[type="submit"][value*="Next"]'
      ];
      
      const nextClicked = await reliableClick(page, nextSelectors, plan_id, supabase, "Next");
      if (nextClicked) {
        try {
          await page.waitForURL(/\/registration\/.*\/options/, { timeout: 30000 });
          // Human-like delay after navigation
          await humanizedDelay(2000, 4000);
        } catch (error) {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: `Worker: Navigation to options may have failed: ${error.message}` 
          });
        }
      }
    }
    
    // Step 3: Options Page (/registration/*/options) - Fill add-ons
    currentUrl = page.url();
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: Current URL: ${currentUrl}` 
    });
    
    if (currentUrl.match(/\/registration\/.*\/options/)) {
      // Human-like scroll and delay before handling options
      await humanizedScroll(page, plan_id, supabase);
      await humanizedDelay(1000, 2000);
      
      // Handle add-ons using the dedicated function (never sets final status)
      await handleBlackhawkOptions(page, plan, supabase);
    }
    
    // Step 4: Cart Page (/cart) - Click Checkout button
    currentUrl = page.url();
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: Current URL: ${currentUrl}` 
    });
    
    if (currentUrl.includes('/cart')) {
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: "Worker: On cart page" 
      });
      
      // Human-like behavior before checkout
      await humanizedScroll(page, plan_id, supabase);
      await humanizedDelay(1500, 3000);
      
      const checkoutSelectors = [
        '#edit-checkout',
        'button#edit-checkout',
        'button:has-text("Checkout")'
      ];
      
      const checkoutClicked = await reliableClick(page, checkoutSelectors, plan_id, supabase, "Checkout");
      if (checkoutClicked) {
        try {
          await page.waitForURL(/\/checkout\/.*\/installments/, { timeout: 30000 });
          // Human-like delay after checkout navigation
          await humanizedDelay(2000, 4000);
        } catch (error) {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: `Worker: Failed to navigate to installments page: ${error.message}` 
          });
        }
      }
    }
    
    // Step 5: Installments Page (/checkout/*/installments) - Select payment method and continue
    currentUrl = page.url();
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: Current URL: ${currentUrl}` 
    });
    
    if (currentUrl.match(/\/checkout\/.*\/installments/)) {
      // Human-like scroll and delay on installments page
      await humanizedScroll(page, plan_id, supabase);
      await humanizedDelay(1000, 2000);
      
      // Ensure saved card is selected (default to first radio if none) 
      try {
        const savedCardRadio = await scrollUntilVisible(page, 'input[type="radio"]', 15);
        const isChecked = await savedCardRadio.isChecked();
        if (!isChecked) {
          // Human-like mouse movement before clicking radio
          await humanizedMouseMove(page, savedCardRadio);
          await humanizedDelay(100, 300);
          await savedCardRadio.click();
        }
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: Payment method selected with human-like behavior" 
        });
      } catch (error) {
        // No radio buttons found - continue with default selection
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: No payment method radio buttons found, continuing with defaults" 
        });
      }
      
      const continueSelectors = [
        '#edit-actions-next',
        'button#edit-actions-next',
        'button:has-text("Continue to Review")'
      ];
      
      const continueClicked = await reliableClick(page, continueSelectors, plan_id, supabase, "Continue to Review");
      if (continueClicked) {
        try {
          await page.waitForURL(/\/checkout\/.*\/review/, { timeout: 30000 });
          // Human-like delay after navigation to review
          await humanizedDelay(2000, 4000);
        } catch (error) {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: `Worker: Failed to navigate to review page: ${error.message}` 
          });
        }
      }
    }
    
    // Step 6: Review Page (/checkout/*/review) - Complete purchase
    currentUrl = page.url();
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: `Worker: Current URL: ${currentUrl}` 
    });
    
    if (currentUrl.match(/\/checkout\/.*\/review/)) {
      // Human-like scroll and delay on review page
      await humanizedScroll(page, plan_id, supabase);
      await humanizedDelay(1500, 3000);
      
      // Fill CVV if available and field exists
      if (credentials.cvv) {
        const cvvSelectors = [
          'input[name*="cvv"]', 'input[id*="cvv"]', 'input[name*="security"]',
          'input[id*="security"]', 'input[placeholder*="CVV"]', 'input[name*="cvc"]'
        ];
        
        let cvvFilled = false;
        for (const selector of cvvSelectors) {
          try {
            const cvvField = await scrollUntilVisible(page, selector, 15);
            
            // Human-like CVV typing with per-character delays
            await humanizedType(cvvField, String(credentials.cvv));
            
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: "Worker: CVV entered with human-like typing" 
            });
            cvvFilled = true;
            break;
          } catch (error) {
            // Continue to next selector
            console.log(`CVV selector ${selector} failed: ${error.message}`);
          }
        }
        
        if (!cvvFilled) {
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: CVV field not found, continuing without CVV" 
          });
        }
      }
      
      // Human-like delay before final payment
      await humanizedDelay(1000, 2000);
      
      const paySelectors = [
        'button:has-text("Pay and complete purchase")'
      ];
      
      const payClicked = await reliableClick(page, paySelectors, plan_id, supabase, "Pay and complete purchase");
      if (payClicked) {
        // Wait for completion and detect success
        try {
          await Promise.race([
            page.waitForURL(/\/checkout\/.*\/complete/, { timeout: 30000 }),
            page.waitForSelector('text=/Thank you|Registration complete|successfully registered/i', { timeout: 30000 })
          ]);
          
          const finalUrl = page.url();
          const finalContent = await page.content().catch(() => '');
          
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: `Worker: After payment - URL: ${finalUrl}` 
          });
          
          // Check for success indicators
          const hasSuccessUrl = finalUrl.match(/\/checkout\/.*\/complete/) || 
                               finalUrl.includes('/complete') || 
                               finalUrl.includes('/thank-you') || 
                               finalUrl.includes('/success');
          
          const hasSuccessText = /(Thank you|Registration complete|successfully registered)/i.test(finalContent);
          
          if (hasSuccessUrl || hasSuccessText) {
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: "Worker: Signup confirmed" 
            });
            
            // Update plan status to completed - only executeSignup decides final success/failure
            await supabase
              .from('plans')
              .update({ 
                status: 'completed',
                completed_at: new Date().toISOString()
              })
              .eq('id', plan_id);
            
            return { 
              success: true, 
              requiresAction: false,
              details: { message: 'Signup completed successfully' }
            };
          } else {
            // Success not detected
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
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: `Worker: Payment confirmation timeout: ${error.message}` 
          });
          
          // Update plan status to action_required
          await supabase
            .from('plans')
            .update({ status: 'action_required' })
            .eq('id', plan_id);
          
          return { 
            success: true, 
            requiresAction: true,
            details: { message: 'Payment confirmation timeout, manual check required' }
          };
        }
      }
    }
    
    // If we reach here without completing, mark as action required
    await supabase.from("plan_logs").insert({ 
      plan_id, 
      msg: "Worker: Signup may not have completed, manual check required" 
    });
    
    await supabase
      .from('plans')
      .update({ status: 'action_required' })
      .eq('id', plan_id);
    
    return { 
      success: true, 
      requiresAction: true,
      details: { message: 'Signup flow incomplete, manual check required' }
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
