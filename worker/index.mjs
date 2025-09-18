console.log("🚀 Worker starting up...");
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";

// ===== SHARED HELPER FUNCTIONS =====
/**
 * Scrolls until a selector becomes visible or throws after max attempts
 * @param page Playwright page instance
 * @param selector CSS selector to find and scroll to
 * @param maxScrolls Maximum number of scroll attempts (default: 20)
 * @returns The visible element
 * @throws Error if element not found or not visible after maxScrolls
 */
async function scrollUntilVisible(page, selector, maxScrolls = 20) {
  for (let i = 0; i < maxScrolls; i++) {
    const element = page.locator(selector).first();
    if (await element.count()) {
      try {
        await element.scrollIntoViewIfNeeded();
        await element.waitFor({ state: "visible", timeout: 2000 });
        return element;
      } catch {
        // continue scrolling
      }
    }
    // scroll down a bit and retry
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
  }
  throw new Error(`Element not visible for selector: ${selector}`);
}

// ===== INFRASTRUCTURE: PROCESS ERROR HANDLERS =====
// Prevent silent crashes that cause 502 errors
process.on('uncaughtException', async (error) => {
  console.error('🚨 Uncaught Exception:', error);
  try {
    // Log to Supabase if possible
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    await supabase.from('plan_logs').insert({
      plan_id: 'SYSTEM',
      msg: `CRITICAL ERROR: Uncaught Exception: ${error.message}`
    });
  } catch (e) {
    console.error('Failed to log uncaught exception:', e);
  }
  // Give time to log before exit
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    await supabase.from('plan_logs').insert({
      plan_id: 'SYSTEM',
      msg: `CRITICAL ERROR: Unhandled Rejection: ${String(reason)}`
    });
  } catch (e) {
    console.error('Failed to log unhandled rejection:', e);
  }
});

const app = express();
app.use(express.json());

// ===== POLICY CONSTANTS =====
const CAPTCHA_AUTOSOLVE_ENABLED = false; // NEVER call a CAPTCHA solver - SMS + verify link only
const PER_USER_WEEKLY_LIMIT = 3; // Maximum plans per user per 7 days  
const SMS_IMMEDIATE_ON_ACTION_REQUIRED = true; // Send SMS immediately when action required
const HOLD_OPEN_ENABLED = process.env.HOLD_OPEN_ENABLED === 'true'; // Keep browser open on target page until open_time

// ===== EXPANDED REGISTER SELECTORS FOR COMPREHENSIVE DETECTION =====
const REGISTER_SELECTORS = [
  'button:has-text("Register")',
  'a:has-text("Register")',
  'input[type="submit"][value*="Register" i]',
  '[value*="Register" i]',
  // Broader registration terms
  'button:has-text("Enroll")',
  'a:has-text("Enroll")',
  'button:has-text("Sign Up")',
  'a:has-text("Sign Up")',
  'button:has-text("Join")',
  'a:has-text("Join")',
  'button:has-text("Book")',
  'a:has-text("Book")',
  'button:has-text("Reserve")',
  'a:has-text("Reserve")',
  'button:has-text("Details")',
  'a:has-text("Details")',
  'button:has-text("Add to Cart")',
  'a:has-text("Add to Cart")',
  // CSS class-based selectors for common frameworks
  '[class*="register"]',
  '[class*="enroll"]',
  '[class*="signup"]',
  '[class*="book"]'
];

// ===== ADVANCED ANTI-BOT: RANDOMIZATION UTILITIES =====

// Real browser user agent pool for randomization
const USER_AGENT_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0'
];

// Viewport size pool for randomization
const VIEWPORT_POOL = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 }
];

// Timezone pool for randomization
const TIMEZONE_POOL = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Vancouver', 'Europe/London', 'Europe/Berlin'
];

// Language pool for randomization
const LANGUAGE_POOL = ['en-US', 'en-CA', 'en-GB'];

// Weighted random delay generator (favors human-like timing)
function getWeightedRandomDelay(minMs, maxMs) {
  // Create weighted distribution favoring middle values
  const weights = [0.1, 0.2, 0.4, 0.2, 0.1]; // Bell curve
  const segments = weights.length;
  const segmentSize = (maxMs - minMs) / segments;
  
  // Select segment based on weights
  let random = Math.random();
  let selectedSegment = 0;
  let cumulative = 0;
  
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (random <= cumulative) {
      selectedSegment = i;
      break;
    }
  }
  
  // Random value within selected segment
  const segmentStart = minMs + (selectedSegment * segmentSize);
  const segmentEnd = segmentStart + segmentSize;
  
  return Math.floor(Math.random() * (segmentEnd - segmentStart)) + segmentStart;
}

// Context-aware delay (longer for complex pages)
function getContextAwareDelay(baseMin, baseMax, complexity = 1) {
  const multiplier = Math.max(1, complexity);
  return getWeightedRandomDelay(baseMin * multiplier, baseMax * multiplier);
}

// Random browser characteristics
function getRandomBrowserProfile() {
  return {
    userAgent: USER_AGENT_POOL[Math.floor(Math.random() * USER_AGENT_POOL.length)],
    viewport: VIEWPORT_POOL[Math.floor(Math.random() * VIEWPORT_POOL.length)],
    timezone: TIMEZONE_POOL[Math.floor(Math.random() * TIMEZONE_POOL.length)],
    language: LANGUAGE_POOL[Math.floor(Math.random() * LANGUAGE_POOL.length)]
  };
}

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

// ===== INFRASTRUCTURE: ASYNCHRONOUS /run-plan ENDPOINT =====
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

    // ===== INFRASTRUCTURE FIX: IMMEDIATE RESPONSE + BACKGROUND PROCESSING =====
    // Return HTTP 200 immediately to avoid Railway timeout
    res.status(200).json({
      ok: true,
      msg: 'Plan execution started in background',
      plan_id: plan_id,
      timestamp: new Date().toISOString()
    });

    // Start background execution (non-blocking)
    setImmediate(() => {
      executeRunPlanBackground(plan_id, supabase);
    });

  } catch (error) {
    console.error("❌ Worker error in /run-plan:", error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// Background execution function for /run-plan
async function executeRunPlanBackground(plan_id, supabase) {
  try {
    console.log(`Starting background execution for plan_id: ${plan_id}`);

    // Log the start of the attempt
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Worker: Background execution started - loading plan details...'
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
      return;
    }

    // ===== SINGLE-EXECUTION POLICY =====
    if (plan.status !== 'scheduled' && plan.status !== 'seeded' && plan.status !== 'action_required' && plan.status !== 'executing') {
      console.log(`Ignoring execution request for plan ${plan_id} with status '${plan.status}' - only 'scheduled', 'seeded', 'action_required', or 'executing' plans can be executed`);
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker: Execution ignored - plan status is '${plan.status}' (cannot execute ${plan.status === 'cancelled' ? 'cancelled' : plan.status} plans)`
      });
      return;
    }

    // Update plan status to executing
    await supabase
      .from('plans')
      .update({ status: 'executing' })
      .eq('id', plan_id);

    // Log plan details found
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Plan loaded: ${plan.child_name} at ${plan.org} - proceeding with execution`
    });

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
      
      await supabase
        .from('plans')
        .update({ status: 'failed' })
        .eq('id', plan_id);
      return;
    }

    // Decrypt credentials using the encryption key
    const CRED_ENC_KEY = process.env.CRED_ENC_KEY;
    if (!CRED_ENC_KEY) {
      const errorMsg = 'Encryption key not configured';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker Error: ${errorMsg}`
      });
      
      await supabase
        .from('plans')
        .update({ status: 'failed' })
        .eq('id', plan_id);
      return;
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
      
      await supabase
        .from('plans')
        .update({ status: 'failed' })
        .eq('id', plan_id);
      return;
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

    // ===== ADVANCED ANTI-BOT: RANDOM BROWSER PROFILE =====
    const browserProfile = getRandomBrowserProfile();

    // Create Browserbase session with randomized characteristics
    const browserbaseApiKey = process.env.BROWSERBASE_API_KEY;
    const browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID;
    
    let session = null;
    let browser = null;
    
    try {
      const sessionResp = await fetch("https://api.browserbase.com/v1/sessions", {
        method: "POST",
        headers: { "X-BB-API-Key": browserbaseApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ 
          projectId: browserbaseProjectId,
          browserSettings: {
            viewport: browserProfile.viewport
          }
        })
      });
      if (!sessionResp.ok) {
        const t = await sessionResp.text().catch(()=>"");
        console.error("Session create failed:", sessionResp.status, sessionResp.statusText, t);
        await supabase.from("plan_logs").insert({ plan_id, msg: `Worker Error: Browserbase session failed ${sessionResp.status}` });
        await supabase.from('plans').update({ status: 'failed' }).eq('id', plan_id);
        return;
      }
      session = await sessionResp.json();
      dlog("Browserbase session created:", session);
      await supabase.from("plan_logs").insert({ plan_id, msg: `Worker: ✅ Browserbase session created: ${session.id}` });

      // Connect Playwright over CDP with advanced anti-bot settings
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

        const ctx = browser.contexts()[0] ?? await browser.newContext({
          userAgent: browserProfile.userAgent,
          viewport: browserProfile.viewport,
          locale: browserProfile.language,
          timezoneId: browserProfile.timezone,
          // Advanced anti-bot: Randomize additional characteristics
          hasTouch: Math.random() < 0.3, // 30% chance of touch device
          isMobile: false,
          deviceScaleFactor: 1 + (Math.random() * 0.5), // Slight scale variation
        });
        page = ctx.pages()[0] ?? await ctx.newPage();

        // ===== ADVANCED ANTI-BOT: OVERRIDE NAVIGATOR PROPERTIES =====
        await page.addInitScript(`
          // Randomize canvas fingerprint
          const originalGetContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function(type) {
            const context = originalGetContext.call(this, type);
            if (type === '2d') {
              const originalFillText = context.fillText;
              context.fillText = function() {
                // Add slight randomization to canvas rendering
                context.globalAlpha = 0.99 + Math.random() * 0.01;
                return originalFillText.apply(this, arguments);
              };
            }
            return context;
          };

          // Randomize WebGL fingerprint
          const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) {
              return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
            }
            if (parameter === 37446) {
              return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
            }
            return originalGetParameter.call(this, parameter);
          };

          // Randomize memory info
          Object.defineProperty(navigator, 'deviceMemory', {
            get: () => [4, 8, 16][Math.floor(Math.random() * 3)]
          });

          // Randomize connection info
          Object.defineProperty(navigator, 'connection', {
            get: () => ({
              effectiveType: ['4g', '3g'][Math.floor(Math.random() * 2)],
              rtt: Math.floor(Math.random() * 100) + 50,
              downlink: Math.random() * 10 + 1
            })
          });
        `);

        await supabase.from("plan_logs").insert({ plan_id, msg: "Worker: Playwright connected with enhanced anti-bot profile" });
        dlog("Connected Playwright to session:", session.id);

        // ===== REMOVED ADVANCED SEEDING - NOW DETERMINISTIC =====
        await supabase.from("plan_logs").insert({ 
          plan_id, 
          msg: "Worker: Skipping advanced seeding - proceeding with deterministic approach" 
        });

      } catch (e) {
        console.error("Playwright connect error:", e);
        await supabase.from("plan_logs").insert({
          plan_id,
          msg: "Worker: PLAYWRIGHT_CONNECT_FAILED: " + (e?.message ?? String(e))
        });
        await supabase.from('plans').update({ status: 'failed' }).eq('id', plan_id);
        return;
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
      await page.goto(normalizedBaseUrl, { waitUntil: 'networkidle' });
      
      const content = (await page.content()).toLowerCase();
      const url = page.url();
      const loggedIn = url.includes('dashboard') || content.includes('logout') || content.includes('sign out');
      
      if (loggedIn) {
        await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: Already logged in (restored session)' });
      } else {
        // Proceed with existing login flow
        const loginUrl = `${normalizedBaseUrl}/user/login`;
        console.log(`Worker: Normalized login URL = ${loginUrl}`);
        
        // Perform login with enhanced Playwright
        await supabase.from("plan_logs").insert({ plan_id, msg: `Worker: Navigating to login: ${loginUrl}` });
        const loginResult = await advancedLoginWithPlaywright(page, loginUrl, credentials.email, credentials.password, supabase, plan_id);
        if (!loginResult.success) {
          await supabase.from("plan_logs").insert({
            plan_id,
            msg: `Worker: Login failed: ${loginResult.error}`
          });
          
          await supabase
            .from('plans')
            .update({ status: 'failed' })
            .eq('id', plan_id);
          
          return;
        }
      }

      // Continue with signup execution...
      const signupResult = await executeSignup(page, plan, credentials, nordicColorGroup, nordicRental, volunteer, allowNoCvv, supabase);
      
      // Update plan status based on result
      if (signupResult.success) {
        await supabase
          .from('plans')
          .update({ status: 'completed' })
          .eq('id', plan_id);
        
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Worker: ✅ Plan execution completed successfully`
        });
      } else {
        const newStatus = signupResult.requiresAction ? 'action_required' : 'failed';
        await supabase
          .from('plans')
          .update({ status: newStatus })
          .eq('id', plan_id);
        
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Worker: Plan execution ${signupResult.requiresAction ? 'requires user action' : 'failed'}: ${signupResult.message}`
        });
      }

    } catch (error) {
      console.error("Background execution error:", error);
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Worker: Background execution error: ${error.message}` 
      });

      await supabase
        .from('plans')
        .update({ status: 'failed' })
        .eq('id', plan_id);
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
    console.error("❌ Critical background execution error:", error);
    try {
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker: CRITICAL BACKGROUND ERROR: ${error.message}`
      });
      await supabase.from('plans').update({ status: 'failed' }).eq('id', plan_id);
    } catch (e) {
      console.error("Failed to log critical error:", e);
    }
  }
}

// ===== INFRASTRUCTURE: ASYNCHRONOUS /seed-plan ENDPOINT =====
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

    // Fetch plan to validate it exists
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('id, status, open_time')
      .eq('id', plan_id)
      .maybeSingle();

    if (planError || !plan) {
      return res.status(404).json({ 
        ok: false, 
        code: 'PLAN_NOT_FOUND', 
        msg: 'Plan not found or access denied',
        details: { plan_id, planError: planError?.message }
      });
    }

    // ===== INFRASTRUCTURE FIX: IMMEDIATE RESPONSE + BACKGROUND PROCESSING =====
    // Return HTTP 200 immediately to avoid Railway timeout
    res.status(200).json({
      ok: true,
      msg: 'Session seeding started in background',
      plan_id: plan_id,
      timestamp: new Date().toISOString()
    });

    // Update plan status to 'seeding' to track progress
    await supabase
      .from('plans')
      .update({ status: 'seeding' })
      .eq('id', plan_id);

    // Start background seeding (non-blocking)
    setImmediate(() => {
      executeSeedPlanBackground(plan_id, supabase);
    });

  } catch (error) {
    console.error("❌ Worker error in /seed-plan:", error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// Background execution function for /seed-plan
async function executeSeedPlanBackground(plan_id, supabase) {
  try {
    console.log(`Starting background seeding for plan_id: ${plan_id}`);

    // Log the start of seeding
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Worker: Background seeding started - loading plan details...'
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
      await supabase.from('plans').update({ status: 'failed' }).eq('id', plan_id);
      return;
    }

    // ===== ADVANCED ANTI-BOT: RANDOM BROWSER PROFILE =====
    const browserProfile = getRandomBrowserProfile();

    // Create Browserbase session with randomized characteristics
    const browserbaseApiKey = process.env.BROWSERBASE_API_KEY;
    const browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID;
    
    let session = null;
    let browser = null;
    
    try {
      const sessionResp = await fetch("https://api.browserbase.com/v1/sessions", {
        method: "POST",
        headers: { "X-BB-API-Key": browserbaseApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ 
          projectId: browserbaseProjectId,
          browserSettings: {
            viewport: browserProfile.viewport
          }
        })
      });
      if (!sessionResp.ok) {
        const t = await sessionResp.text().catch(()=>"");
        console.error("Session create failed:", sessionResp.status, sessionResp.statusText, t);
        await supabase.from("plan_logs").insert({ plan_id, msg: `Worker Error: Browserbase session failed ${sessionResp.status}` });
        await supabase.from('plans').update({ status: 'failed' }).eq('id', plan_id);
        return;
      }
      session = await sessionResp.json();
      await supabase.from("plan_logs").insert({ plan_id, msg: `Worker: ✅ Browserbase session created: ${session.id}` });

      // Connect Playwright over CDP with enhanced anti-bot settings
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

        const ctx = browser.contexts()[0] ?? await browser.newContext({
          userAgent: browserProfile.userAgent,
          viewport: browserProfile.viewport,
          locale: browserProfile.language,
          timezoneId: browserProfile.timezone,
          // Advanced anti-bot: Randomize additional characteristics
          hasTouch: Math.random() < 0.3, // 30% chance of touch device
          isMobile: false,
          deviceScaleFactor: 1 + (Math.random() * 0.5), // Slight scale variation
        });
        page = ctx.pages()[0] ?? await ctx.newPage();

        // ===== ADVANCED ANTI-BOT: OVERRIDE NAVIGATOR PROPERTIES =====
        await page.addInitScript(`
          // Randomize canvas fingerprint
          const originalGetContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function(type) {
            const context = originalGetContext.call(this, type);
            if (type === '2d') {
              const originalFillText = context.fillText;
              context.fillText = function() {
                // Add slight randomization to canvas rendering
                context.globalAlpha = 0.99 + Math.random() * 0.01;
                return originalFillText.apply(this, arguments);
              };
            }
            return context;
          };

          // Randomize WebGL fingerprint
          const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) {
              return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
            }
            if (parameter === 37446) {
              return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
            }
            return originalGetParameter.call(this, parameter);
          };

          // Randomize memory info
          Object.defineProperty(navigator, 'deviceMemory', {
            get: () => [4, 8, 16][Math.floor(Math.random() * 3)]
          });

          // Randomize connection info
          Object.defineProperty(navigator, 'connection', {
            get: () => ({
              effectiveType: ['4g', '3g'][Math.floor(Math.random() * 2)],
              rtt: Math.floor(Math.random() * 100) + 50,
              downlink: Math.random() * 10 + 1
            })
          });
        `);

        await supabase.from("plan_logs").insert({ plan_id, msg: "Worker: Playwright connected for advanced seeding" });

        // ===== ADVANCED SESSION SEEDING WITH TIMING =====
        const seedResult = await advancedSeedBrowserSessionWithTiming(page, plan, plan_id, supabase);
        
        if (seedResult) {
          await supabase.from('plans').update({ status: 'seeded' }).eq('id', plan_id);
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: ✅ Session seeding completed successfully" 
          });
        } else {
          await supabase.from('plans').update({ status: 'failed' }).eq('id', plan_id);
          await supabase.from("plan_logs").insert({ 
            plan_id, 
            msg: "Worker: ❌ Session seeding failed" 
          });
        }

        // Optional HOLD_OPEN mode for maximum speed
        if (HOLD_OPEN_ENABLED && plan.open_time) {
          const openTime = new Date(plan.open_time);
          const now = new Date();
          
          // Only hold open if we have time remaining (at least 2 minutes)
          const timeRemaining = openTime.getTime() - now.getTime();
          if (timeRemaining > 2 * 60 * 1000) {
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: "Worker: Entering HOLD_OPEN mode - navigating to target page" 
            });
            
            await advancedHoldOpenOnTargetPage(page, plan, supabase, openTime);
            return; // Keep session open
          } else {
            await supabase.from("plan_logs").insert({ 
              plan_id, 
              msg: "Worker: HOLD_OPEN skipped - insufficient time remaining" 
            });
          }
        }

      } catch (e) {
        console.error("Playwright connect error:", e);
        await supabase.from("plan_logs").insert({
          plan_id,
          msg: "Worker: PLAYWRIGHT_CONNECT_FAILED: " + (e?.message ?? String(e))
        });
        await supabase.from('plans').update({ status: 'failed' }).eq('id', plan_id);
        return;
      }

    } catch (error) {
      console.error("Background seeding error:", error);
      await supabase.from("plan_logs").insert({ 
        plan_id, 
        msg: `Worker: Background seeding error: ${error.message}` 
      });
      await supabase.from('plans').update({ status: 'failed' }).eq('id', plan_id);
    } finally {
      // Clean up browser connection and Browserbase session (unless HOLD_OPEN)
      if (browser && !HOLD_OPEN_ENABLED) {
        try {
          await browser.close();
          await supabase.from("plan_logs").insert({ plan_id, msg: "Worker: Browser connection closed" });
        } catch (e) {
          console.error("Error closing browser:", e);
        }
      }
      
      // Close Browserbase session (unless HOLD_OPEN)
      if (session && !HOLD_OPEN_ENABLED) {
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
    console.error("❌ Critical background seeding error:", error);
    try {
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker: CRITICAL SEEDING ERROR: ${error.message}`
      });
      await supabase.from('plans').update({ status: 'failed' }).eq('id', plan_id);
    } catch (e) {
      console.error("Failed to log critical seeding error:", e);
    }
  }
}

// ===== ADVANCED ANTI-BOT: ENHANCED SESSION SEEDING WITH TIMING =====
async function advancedSeedBrowserSessionWithTiming(page, plan, plan_id, supabase) {
  try {
    // Parse open_time and calculate optimal timing
    const openTime = new Date(plan.open_time);
    const currentTime = new Date();
    
    // Advanced timing calculation with randomization
    const SEEDING_DURATION_MS = getWeightedRandomDelay(2 * 60 * 1000, 4 * 60 * 1000); // 2-4 minutes randomized
    const seedingStartTime = new Date(openTime.getTime() - SEEDING_DURATION_MS);
    
    await supabase.from("plan_logs").insert({
      plan_id, 
      msg: `Worker: Advanced timing calibration - Open: ${openTime.toISOString()}, Seeding start: ${seedingStartTime.toISOString()}, Current: ${currentTime.toISOString()}`
    });

    // If we're before seeding time, wait with randomization
    if (currentTime < seedingStartTime) {
      const waitTime = seedingStartTime.getTime() - currentTime.getTime();
      // Add small random variation to avoid synchronized starts
      const randomizedWaitTime = waitTime + getWeightedRandomDelay(-30000, 30000); // ±30 seconds
      
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: `Worker: Waiting ${Math.round(randomizedWaitTime/1000)}s until optimal seeding start time`
      });
      
      await new Promise(resolve => setTimeout(resolve, Math.max(0, randomizedWaitTime)));
      
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: "Worker: Starting advanced session seeding at optimal time"
      });
    } else {
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: "Worker: Starting advanced session seeding immediately (past optimal start time)"
      });
    }

    // Perform the advanced session seeding
    const seedResult = await advancedSeedBrowserSession(page, plan, supabase);
    
    if (!seedResult) {
      return false;
    }
    
    // After seeding, wait until randomized time before open_time
    const signupBuffer = getWeightedRandomDelay(15000, 45000); // 15-45 seconds before open
    const signupStartTime = new Date(openTime.getTime() - signupBuffer);
    const nowAfterSeeding = new Date();
    
    if (nowAfterSeeding < signupStartTime) {
      const finalWaitTime = signupStartTime.getTime() - nowAfterSeeding.getTime();
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: `Worker: Advanced seeding complete. Waiting ${Math.round(finalWaitTime/1000)}s until optimal execution time`
      });
      
      // Random micro-activities during wait
      const microActivityInterval = getWeightedRandomDelay(30000, 60000);
      let lastMicroActivity = Date.now();
      
      while (Date.now() < signupStartTime.getTime()) {
        const now = Date.now();
        if (now - lastMicroActivity > microActivityInterval) {
          // Perform subtle micro-activity
          await advancedMicroActivity(page);
          lastMicroActivity = now;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: ✅ Advanced session seeding and timing calibration complete"
    });

    return true;

  } catch (error) {
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: `Worker: Advanced timing calibration error: ${error.message}`
    });
    // Still attempt basic seeding as fallback
    try {
      return await advancedSeedBrowserSession(page, plan, supabase);
    } catch (seedError) {
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: `Worker: Fallback advanced seeding failed: ${seedError.message}`
      });
      return false;
    }
  }
}

// ===== ADVANCED ANTI-BOT: ENHANCED SESSION SEEDING =====
async function advancedSeedBrowserSession(page, plan, supabase, opts={}) {
  const plan_id = plan.id;
  try {
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: Starting advanced session seeding with sophisticated anti-bot measures"
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

    // ===== PHASE 1: SOPHISTICATED HOMEPAGE EXPLORATION =====
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: Phase 1 - Sophisticated homepage exploration with human behavior patterns"
    });
    
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    
    // Advanced initial page analysis
    const pageComplexity = await analyzePageComplexity(page);
    const initialDwellTime = getContextAwareDelay(15000, 30000, pageComplexity);
    
    await advancedHumanizedDelay(initialDwellTime);
    
    // Advanced mouse movement simulation
    await advancedSimulateMouseMovement(page);
    
    // Sophisticated scrolling with reading simulation
    await advancedHumanizedScroll(page, plan_id, supabase);
    
    // Extended dwell time with micro-activities
    await advancedDwellTime(page, initialDwellTime, supabase, plan_id);

    // ===== PHASE 2: INTELLIGENT PROGRAM DISCOVERY =====
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: Phase 2 - Intelligent program discovery with randomized exploration paths"
    });

    // Randomized discovery approach
    const discoveryApproaches = [
      () => discoverViaNavigation(page, plan_id, supabase),
      () => discoverViaSearch(page, plan_id, supabase),
      () => discoverViaDirectLinks(page, plan_id, supabase)
    ];
    
    // Shuffle approaches for unpredictability
    for (let i = discoveryApproaches.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [discoveryApproaches[i], discoveryApproaches[j]] = [discoveryApproaches[j], discoveryApproaches[i]];
    }

    let discoverySuccess = false;
    for (const approach of discoveryApproaches) {
      try {
        if (await approach()) {
          discoverySuccess = true;
          break;
        }
        // Random delay between attempts
        await advancedHumanizedDelay(getWeightedRandomDelay(3000, 8000));
      } catch (e) {
        // Continue to next approach
      }
    }

    if (discoverySuccess) {
      await supabase.from("plan_logs").insert({
        plan_id,
        msg: "Worker: Program discovery successful, exploring with advanced behavior patterns"
      });
      
      // Advanced content exploration
      await advancedContentExploration(page, plan, supabase);
    }

    // ===== PHASE 3: SOPHISTICATED TARGET INTEREST SIMULATION =====
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: Phase 3 - Sophisticated target program interest simulation"
    });

    await advancedTargetInterestSimulation(page, plan, supabase);

    // ===== PHASE 4: ADVANCED DECISION PAUSE AND PREPARATION =====
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: Phase 4 - Advanced decision pause with realistic hesitation patterns"
    });

    await advancedDecisionSimulation(page, plan, supabase);

    // ===== SAVE SESSION STATE =====
    await saveAdvancedSessionState(page, plan, supabase);

    await supabase.from("plan_logs").insert({
      plan_id,
      msg: "Worker: ✅ Advanced session seeding completed with sophisticated anti-bot measures"
    });

    return true;

  } catch (error) {
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: `Worker: Advanced session seeding error: ${error.message}`
    });
    return false;
  }
}

// ===== ADVANCED ANTI-BOT: ENHANCED HUMAN BEHAVIOR UTILITIES =====

// Advanced humanized delay with weighted random distribution
async function advancedHumanizedDelay(baseMs) {
  // Add natural variation (±20%)
  const variation = baseMs * 0.2;
  const delay = baseMs + (Math.random() * 2 - 1) * variation;
  
  // Simulate typing/thinking pauses within longer delays
  if (delay > 10000) {
    const segments = Math.floor(delay / 3000); // Break into 3-second segments
    for (let i = 0; i < segments; i++) {
      await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 1000));
      // Micro-pause to simulate thinking
      if (Math.random() < 0.3) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 500));
      }
    }
    const remainder = delay % 3000;
    if (remainder > 0) {
      await new Promise(resolve => setTimeout(resolve, remainder));
    }
  } else {
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

// Advanced mouse movement with realistic curves and hesitation
async function advancedSimulateMouseMovement(page, targetElement = null) {
  try {
    if (targetElement) {
      // Move to specific element with natural hesitation
      const box = await targetElement.boundingBox();
      if (box) {
        // Random point within element
        const targetX = box.x + box.width * (0.2 + Math.random() * 0.6);
        const targetY = box.y + box.height * (0.2 + Math.random() * 0.6);
        
        // Move in segments with hesitation
        await advancedMouseMove(page, targetX, targetY);
        
        // Hesitation hover
        await advancedHumanizedDelay(getWeightedRandomDelay(1000, 3000));
      }
    } else {
      // Random explorative movements
      const viewport = page.viewportSize();
      const movements = Math.floor(Math.random() * 4) + 3; // 3-6 movements
      
      for (let i = 0; i < movements; i++) {
        const x = Math.floor(Math.random() * viewport.width * 0.8) + viewport.width * 0.1;
        const y = Math.floor(Math.random() * viewport.height * 0.8) + viewport.height * 0.1;
        
        await advancedMouseMove(page, x, y);
        await advancedHumanizedDelay(getWeightedRandomDelay(1000, 3000));
      }
    }
  } catch (e) {
    // Ignore mouse movement errors
  }
}

// Advanced mouse movement with realistic curves
async function advancedMouseMove(page, targetX, targetY) {
  try {
    const currentPos = { x: Math.random() * 100, y: Math.random() * 100 }; // Start position
    const steps = Math.floor(Math.random() * 20) + 10; // 10-30 steps
    
    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      
      // Ease-in-out curve for natural movement
      const easeProgress = 0.5 * (1 - Math.cos(progress * Math.PI));
      
      // Add slight randomness to path
      const noise = (Math.random() - 0.5) * 10;
      
      const x = currentPos.x + (targetX - currentPos.x) * easeProgress + noise;
      const y = currentPos.y + (targetY - currentPos.y) * easeProgress + noise;
      
      await page.mouse.move(x, y);
      
      // Variable speed (slower at start/end, faster in middle)
      const speed = Math.sin(progress * Math.PI) * 50 + 20;
      await new Promise(resolve => setTimeout(resolve, speed));
    }
  } catch (e) {
    // Fallback to simple move
    await page.mouse.move(targetX, targetY);
  }
}

// Advanced scrolling with reading patterns
async function advancedHumanizedScroll(page, plan_id, supabase) {
  try {
    const viewport = page.viewportSize();
    const scrollSessions = Math.floor(Math.random() * 3) + 2; // 2-4 scroll sessions
    
    for (let session = 0; session < scrollSessions; session++) {
      // Random scroll direction and amount
      const scrollDown = Math.random() > 0.2; // 80% down, 20% up
      const scrollAmount = Math.floor(Math.random() * viewport.height * 0.8) + 100;
      
      // Scroll in natural segments
      const segments = Math.floor(scrollAmount / 100) + 1;
      
      for (let i = 0; i < segments; i++) {
        const segmentScroll = scrollDown ? 100 : -100;
        await page.mouse.wheel(0, segmentScroll);
        
        // Reading pause
        await advancedHumanizedDelay(getWeightedRandomDelay(200, 800));
        
        // Occasional hesitation (like re-reading)
        if (Math.random() < 0.3) {
          await page.mouse.wheel(0, scrollDown ? -20 : 20); // Small reverse scroll
          await advancedHumanizedDelay(getWeightedRandomDelay(500, 1500));
        }
      }
      
      // Pause between scroll sessions
      await advancedHumanizedDelay(getWeightedRandomDelay(3000, 8000));
    }
  } catch (e) {
    // Ignore scroll errors
  }
}

// Advanced dwell time with micro-activities
async function advancedDwellTime(page, baseDwellMs, supabase, plan_id) {
  const startTime = Date.now();
  const endTime = startTime + baseDwellMs;
  
  while (Date.now() < endTime) {
    // Random micro-activities
    const activity = Math.random();
    
    if (activity < 0.3) {
      // Micro-scroll
      await page.mouse.wheel(0, (Math.random() - 0.5) * 50);
    } else if (activity < 0.6) {
      // Small mouse movement
      const currentPos = { x: Math.random() * 100, y: Math.random() * 100 };
      await page.mouse.move(
        currentPos.x + (Math.random() - 0.5) * 30,
        currentPos.y + (Math.random() - 0.5) * 30
      );
    } else {
      // Just wait (simulating reading/thinking)
    }
    
    // Random interval between micro-activities
    await advancedHumanizedDelay(getWeightedRandomDelay(2000, 8000));
  }
}

// Analyze page complexity to adjust timing
async function analyzePageComplexity(page) {
  try {
    const elementCount = await page.locator('*').count();
    const imageCount = await page.locator('img').count();
    const linkCount = await page.locator('a').count();
    
    // Simple complexity score
    const complexity = Math.min((elementCount + imageCount * 2 + linkCount) / 1000, 3);
    return complexity;
  } catch (e) {
    return 1; // Default complexity
  }
}

// Advanced content exploration
async function advancedContentExploration(page, plan, supabase) {
  const plan_id = plan.id;
  
  try {
    // Find interesting elements to explore
    const interestingElements = await page.locator('a, button, [role="button"]').all();
    const elementsToExplore = interestingElements.slice(0, Math.min(5, interestingElements.length));
    
    for (const element of elementsToExplore) {
      try {
        if (await element.isVisible()) {
          await advancedSimulateMouseMovement(page, element);
          
          // Simulate reading the element text
          const text = await element.textContent();
          const readingTime = Math.min((text?.length || 0) * 100, 5000);
          await advancedHumanizedDelay(readingTime);
          
          // Random chance to hover longer (showing interest)
          if (Math.random() < 0.4) {
            await advancedHumanizedDelay(getWeightedRandomDelay(2000, 5000));
          }
        }
      } catch (e) {
        // Continue with next element
      }
    }
  } catch (e) {
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: `Worker: Content exploration error (continuing): ${e.message}`
    });
  }
}

// Advanced target interest simulation
async function advancedTargetInterestSimulation(page, plan, supabase) {
  const plan_id = plan.id;
  
  try {
    // Build interest keywords from plan
    const targetKeywords = [
      plan.preferred_class_name,
      plan.child_name,
      plan.preferred?.split(' ')[0], // Day of week
      'Nordic', 'Kids', 'Junior'
    ].filter(Boolean);

    for (const keyword of targetKeywords) {
      try {
        const elements = await page.locator(`text="${keyword}"`).all();
        
        for (let i = 0; i < Math.min(elements.length, 3); i++) {
          const element = elements[i];
          
          if (await element.isVisible()) {
            // Show progressive interest (multiple visits to same elements)
            await advancedSimulateMouseMovement(page, element);
            await advancedHumanizedDelay(getWeightedRandomDelay(3000, 7000));
            
            // Simulate comparing (look at nearby elements)
            const nearbyElements = await element.locator('xpath=..//*').all();
            if (nearbyElements.length > 0) {
              const randomNearby = nearbyElements[Math.floor(Math.random() * Math.min(nearbyElements.length, 3))];
              await advancedSimulateMouseMovement(page, randomNearby);
              await advancedHumanizedDelay(getWeightedRandomDelay(2000, 4000));
              
              // Return to target (showing preference)
              await advancedSimulateMouseMovement(page, element);
              await advancedHumanizedDelay(getWeightedRandomDelay(1000, 3000));
            }
          }
        }
      } catch (e) {
        // Continue with next keyword
      }
    }
  } catch (e) {
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: `Worker: Target interest simulation error (continuing): ${e.message}`
    });
  }
}

// Advanced decision simulation
async function advancedDecisionSimulation(page, plan, supabase) {
  const plan_id = plan.id;
  
  try {
    // Simulate decision-making process
    const decisionPhases = ['consideration', 'hesitation', 'confirmation'];
    
    for (const phase of decisionPhases) {
      switch (phase) {
        case 'consideration':
          // Review key information areas
          await advancedHumanizedScroll(page, plan_id, supabase);
          await advancedHumanizedDelay(getWeightedRandomDelay(5000, 10000));
          break;
          
        case 'hesitation':
          // Simulate uncertainty with back-and-forth movements
          for (let i = 0; i < 3; i++) {
            await advancedSimulateMouseMovement(page);
            await advancedHumanizedDelay(getWeightedRandomDelay(2000, 5000));
          }
          break;
          
        case 'confirmation':
          // Final review before action
          await advancedHumanizedScroll(page, plan_id, supabase);
          await advancedHumanizedDelay(getWeightedRandomDelay(3000, 8000));
          break;
      }
    }
  } catch (e) {
    await supabase.from("plan_logs").insert({
      plan_id,
      msg: `Worker: Decision simulation error (continuing): ${e.message}`
    });
  }
}

// Advanced micro-activity during waits
async function advancedMicroActivity(page) {
  try {
    const activities = [
      async () => await page.mouse.wheel(0, (Math.random() - 0.5) * 30),
      async () => {
        const viewport = page.viewportSize();
        const x = Math.random() * viewport.width;
        const y = Math.random() * viewport.height;
        await page.mouse.move(x, y);
      },
      async () => {
        // Simulate brief attention to different areas
        await new Promise(resolve => setTimeout(resolve, getWeightedRandomDelay(1000, 3000)));
      }
    ];
    
    const activity = activities[Math.floor(Math.random() * activities.length)];
    await activity();
  } catch (e) {
    // Ignore micro-activity errors
  }
}

// Discovery approaches for randomization
async function discoverViaNavigation(page, plan_id, supabase) {
  try {
    const navSelectors = [
      'nav a', '[role="navigation"] a', 'header a', '.menu a', '.navigation a'
    ];
    
    for (const selector of navSelectors) {
      const navLinks = await page.locator(selector).all();
      for (const link of navLinks) {
        const text = await link.textContent();
        if (text && /program|class|registration|enroll/i.test(text)) {
          await advancedSimulateMouseMovement(page, link);
          await advancedHumanizedDelay(getWeightedRandomDelay(1000, 3000));
          await link.click();
          await advancedHumanizedDelay(getWeightedRandomDelay(3000, 6000));
          return true;
        }
      }
    }
  } catch (e) {
    // Method failed
  }
  return false;
}

async function discoverViaSearch(page, plan_id, supabase) {
  try {
    const searchSelectors = ['input[type="search"]', 'input[placeholder*="search" i]', '#search', '.search input'];
    
    for (const selector of searchSelectors) {
      const searchInput = page.locator(selector).first();
      if (await searchInput.isVisible()) {
        await advancedSimulateMouseMovement(page, searchInput);
        await searchInput.click();
        await advancedHumanizedDelay(getWeightedRandomDelay(1000, 2000));
        
        // Type search term with human-like typing
        const searchTerm = 'programs';
        await advancedHumanizedType(page, searchInput, searchTerm);
        await page.keyboard.press('Enter');
        await advancedHumanizedDelay(getWeightedRandomDelay(2000, 5000));
        return true;
      }
    }
  } catch (e) {
    // Method failed
  }
  return false;
}

async function discoverViaDirectLinks(page, plan_id, supabase) {
  try {
    const directSelectors = [
      'a[href*="program"]', 'a[href*="registration"]', 'a[href*="class"]',
      'button:has-text("Register")', 'a:has-text("Programs")'
    ];
    
    for (const selector of directSelectors) {
      const element = page.locator(selector).first();
      if (await element.isVisible()) {
        await advancedSimulateMouseMovement(page, element);
        await advancedHumanizedDelay(getWeightedRandomDelay(1000, 3000));
        await element.click();
        await advancedHumanizedDelay(getWeightedRandomDelay(3000, 6000));
        return true;
      }
    }
  } catch (e) {
    // Method failed
  }
  return false;
}

// Advanced humanized typing
async function advancedHumanizedType(page, element, text) {
  try {
    await element.focus();
    
    for (const char of text) {
      await element.type(char);
      
      // Human-like typing speed variation
      const typeDelay = getWeightedRandomDelay(80, 200);
      await new Promise(resolve => setTimeout(resolve, typeDelay));
      
      // Occasional hesitation (like thinking about spelling)
      if (Math.random() < 0.1) {
        await new Promise(resolve => setTimeout(resolve, getWeightedRandomDelay(300, 800)));
      }
    }
  } catch (e) {
    // Fallback to simple type
    await element.type(text);
  }
}

// Advanced session state saving
async function saveAdvancedSessionState(page, plan, supabase) {
  // Same implementation as original but with better error handling
  try {
    const cookies = await page.context().cookies();
    const storage = await page.evaluate(() => ({ 
      local: JSON.stringify(localStorage), 
      session: JSON.stringify(sessionStorage) 
    }));
    
    // Use existing encryption function
    const CRED_ENC_KEY = process.env.CRED_ENC_KEY;
    const keyBytes = Uint8Array.from(atob(CRED_ENC_KEY), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({ cookies, storage, user_id: plan.user_id, plan_id: plan.id }))));
    const payload = { iv: Array.from(iv), ct: Array.from(ct) };
    
    await supabase.from('session_states').insert({
      plan_id: plan.id, 
      user_id: plan.user_id,
      cookies: payload, 
      storage: { stub: true },
      expires_at: new Date(Date.now() + 24*60*60*1000).toISOString()
    });
    
    await supabase.from('plan_logs').insert({ 
      plan_id: plan.id, 
      msg: 'Worker: Advanced session state saved with enhanced security' 
    });
  } catch (e) {
    await supabase.from('plan_logs').insert({ 
      plan_id: plan.id, 
      msg: `Worker: Session save error: ${e.message}` 
    });
  }
}

// ===== ENHANCED LOGIN WITH ADVANCED ANTI-BOT =====
async function advancedLoginWithPlaywright(page, loginUrl, email, password, supabase, plan_id) {
  try {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: "Worker: Navigating to login with advanced behavior patterns"
    });
    
    await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 30000 });
    
    // Wait for Antibot and dynamic content deterministically  
    try {
      await page.waitForSelector('form.antibot', { timeout: 15000 });
    } catch (e) {
      // Antibot form may not exist on all sites
    }
    
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: "Worker: Waiting for login form with deterministic detection"
    });
    
    // Wait for form fields to be available
    await page.waitForSelector('#edit-name', { timeout: 20000 });
    await page.waitForSelector('#edit-pass', { timeout: 20000 });
    
    // Simulate form inspection
    const emailField = page.locator('#edit-name');
    const passwordField = page.locator('#edit-pass');
    
    await advancedSimulateMouseMovement(page, emailField);
    await advancedHumanizedDelay(getWeightedRandomDelay(1000, 2000));
    
    // Advanced form filling
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: "Worker: Filling credentials with human-like patterns"
    });
    
    await emailField.click();
    await advancedHumanizedDelay(getWeightedRandomDelay(500, 1500));
    await advancedHumanizedType(page, emailField, email);
    
    // Tab or click to password field
    if (Math.random() > 0.5) {
      await page.keyboard.press('Tab');
    } else {
      await advancedSimulateMouseMovement(page, passwordField);
      await passwordField.click();
    }
    
    await advancedHumanizedDelay(getWeightedRandomDelay(500, 1500));
    await advancedHumanizedType(page, passwordField, password);
    
    // Pre-submit hesitation
    await advancedHumanizedDelay(getWeightedRandomDelay(1000, 3000));
    
    // Click login button with human-like interaction
    const submitButton = page.locator('#edit-submit');
    await advancedSimulateMouseMovement(page, submitButton);
    await advancedHumanizedDelay(getWeightedRandomDelay(500, 1500));
    await submitButton.click();
    
    // Enhanced login success detection
    try {
      await page.waitForURL(/dashboard/, { timeout: 30000 });
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: "Worker: ✅ Advanced login successful"
      });
      return { success: true };
    } catch (error) {
      // Enhanced fallback detection
      const currentUrl = page.url();
      const content = await page.content();
      
      if (currentUrl.includes('dashboard') || currentUrl.includes('profile') || 
          content.includes('logout') || content.includes('sign out')) {
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: "Worker: ✅ Advanced login successful (fallback detection)"
        });
        return { success: true };
      }
      
      // Enhanced error detection
      const errorSelectors = [
        '.error', '.alert-danger', '[class*="error"]', '[class*="invalid"]',
        '.message--error', '[role="alert"]'
      ];
      
      for (const selector of errorSelectors) {
        try {
          const errorElement = await page.locator(selector).first();
          if (await errorElement.isVisible()) {
            const errorText = await errorElement.textContent();
            if (errorText && errorText.trim()) {
              return { success: false, error: `Login failed: ${errorText.trim()}` };
            }
          }
        } catch (e) {
          // Continue checking other selectors
        }
      }
      
      return { success: false, error: 'Login failed - please check credentials' };
    }
  } catch (error) {
    return { success: false, error: `Advanced login error: ${error.message}` };
  }
}

// Advanced hold open with sophisticated behavior
async function advancedHoldOpenOnTargetPage(page, plan, supabase, openTime) {
  const plan_id = plan.id;
  
  try {
    const base = plan.base_url || 
      `https://${(plan.org||'').toLowerCase().replace(/[^a-z0-9]/g,'')}.skiclubpro.team`;
    
    const registrationUrl = `${base}/registration`;
    await page.goto(registrationUrl, { waitUntil: 'networkidle' });
    
    await supabase.from('plan_logs').insert({ 
      plan_id, 
      msg: `Worker: Advanced hold-open mode until ${openTime.toISOString()}` 
    });

    // Advanced target location with sophisticated interaction
    const targetText = `${plan.preferred_class_name||''} ${plan.preferred||''}`.trim();
    let targetElement = null;
    
    if (targetText) {
      try {
        targetElement = page.locator(`text=${targetText}`).first();
        if (await targetElement.count()) {
          await targetElement.scrollIntoViewIfNeeded();
          await advancedSimulateMouseMovement(page, targetElement);
          await supabase.from('plan_logs').insert({ 
            plan_id, 
            msg: 'Worker: Target program located and positioned' 
          });
        }
      } catch (e) {
        await supabase.from('plan_logs').insert({ 
          plan_id, 
          msg: `Worker: Target location error: ${e.message}` 
        });
      }
    }

    // Advanced hold-open with realistic behavior patterns
    let lastLogTime = Date.now();
    const LOG_INTERVAL = 60 * 1000; // Log every minute
    let lastMajorActivity = Date.now();
    const MAJOR_ACTIVITY_INTERVAL = 5 * 60 * 1000; // Major activity every 5 minutes
    
    while (new Date() < openTime) {
      const now = Date.now();
      const timeUntilOpen = openTime.getTime() - now;
      
      // Log status every minute
      if (now - lastLogTime >= LOG_INTERVAL) {
        const minutesRemaining = Math.ceil(timeUntilOpen / (1000 * 60));
        await supabase.from('plan_logs').insert({ 
          plan_id, 
          msg: `Worker: Advanced hold-open (${minutesRemaining}m remaining)` 
        });
        lastLogTime = now;
      }
      
      // Stop holding 30 seconds before open time
      if (timeUntilOpen <= 30 * 1000) {
        await supabase.from('plan_logs').insert({ 
          plan_id, 
          msg: 'Worker: ✅ Advanced hold-open complete - ready for execution' 
        });
        break;
      }
      
      // Major activity every 5 minutes (page refresh, navigation)
      if (now - lastMajorActivity >= MAJOR_ACTIVITY_INTERVAL) {
        await advancedMajorActivity(page, plan, supabase);
        lastMajorActivity = now;
      } else {
        // Regular micro-activities
        await advancedHoldOpenMicroActivity(page, targetElement);
      }
      
      // Randomized wait between activities
      await new Promise(resolve => setTimeout(resolve, getWeightedRandomDelay(45000, 90000)));
    }
    
  } catch (error) {
    await supabase.from('plan_logs').insert({ 
      plan_id, 
      msg: `Worker: Advanced hold-open error: ${error.message}` 
    });
  }
}

// Advanced major activity during hold-open
async function advancedMajorActivity(page, plan, supabase) {
  const activities = [
    async () => {
      // Refresh page and relocate target
      await page.reload({ waitUntil: 'networkidle' });
      await advancedHumanizedDelay(getWeightedRandomDelay(3000, 6000));
    },
    async () => {
      // Navigate away and return
      const baseUrl = new URL(page.url()).origin;
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await advancedHumanizedDelay(getWeightedRandomDelay(5000, 10000));
      await page.goBack();
      await advancedHumanizedDelay(getWeightedRandomDelay(3000, 6000));
    },
    async () => {
      // Extended exploration
      await advancedContentExploration(page, plan, supabase);
    }
  ];
  
  const activity = activities[Math.floor(Math.random() * activities.length)];
  await activity();
}

// Advanced micro-activity during hold-open
async function advancedHoldOpenMicroActivity(page, targetElement) {
  const activities = [
    async () => {
      // Sophisticated scrolling
      const scrollDirection = Math.random() > 0.7 ? -1 : 1;
      const scrollAmount = getWeightedRandomDelay(30, 80) * scrollDirection;
      await page.mouse.wheel(0, scrollAmount);
    },
    async () => {
      // Advanced mouse movement
      if (targetElement && Math.random() < 0.4) {
        await advancedSimulateMouseMovement(page, targetElement);
      } else {
        await advancedSimulateMouseMovement(page);
      }
    },
    async () => {
      // Keyboard activity simulation
      const keys = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'];
      const key = keys[Math.floor(Math.random() * keys.length)];
      if (Math.random() < 0.3) {
        await page.keyboard.press(key);
      }
    }
  ];
  
  const activity = activities[Math.floor(Math.random() * activities.length)];
  await activity();
}

// ===== BLACKHAWK PROGRAM DISCOVERY =====

async function discoverBlackhawkRegistration(page, plan, supabase) {
  const plan_id = plan.id;
  
  try {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: "Worker: Starting Blackhawk program discovery"
    });

    const baseUrl = plan.base_url || `https://${(plan.org||'').toLowerCase().replace(/[^a-z0-9]/g,'')}.skiclubpro.team`;
    const registrationPages = [`${baseUrl}/registration`, `${baseUrl}/registration/events`];
    
    // Build target text from plan details
    let targetText = '';
    if (plan.preferred_class_name && plan.preferred) {
      targetText = `${plan.preferred_class_name} ${plan.preferred}`;
    } else if (plan.preferred_class_name) {
      targetText = plan.preferred_class_name;
    } else if (plan.preferred) {
      targetText = plan.preferred;
    }
    
    // Deduplicate accidental repeats (e.g. "Wednesday Wednesday")
    if (targetText) {
      const words = targetText.split(/\s+/);
      const uniqueWords = words.filter((word, index) => 
        words.indexOf(word.toLowerCase()) === words.findIndex(w => w.toLowerCase() === word.toLowerCase())
      );
      targetText = uniqueWords.join(' ');
    }
    
    // Fallback to default
    if (!targetText) {
      targetText = "Nordic Kids Wednesday";
    }
    
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Target text constructed: "${targetText}"`
    });

    // Try each registration page
    for (const regUrl of registrationPages) {
      try {
        await page.goto(regUrl, { waitUntil: 'networkidle', timeout: 15000 });
        
        // Deterministic waits
        await page.waitForLoadState("networkidle", { timeout: 15000 });
        
        // Try multiple selector patterns for rows
        const rowSelectors = [".views-row", "tr", ".row", ".program-row", ".event-row", "tbody tr"];
        let foundRows = false;
        
        for (const selector of rowSelectors) {
          try {
            await page.waitForSelector(selector, { timeout: 5000 });
            foundRows = true;
            await supabase.from('plan_logs').insert({
              plan_id,
              msg: `Worker: Found rows using selector: ${selector}`
            });
            break;
          } catch (e) {
            continue;
          }
        }
        
        if (!foundRows) {
          await supabase.from('plan_logs').insert({
            plan_id,
            msg: `Worker: No standard row selectors found on ${regUrl}, proceeding anyway`
          });
        }
        
        // Get first 10 row texts for logging
        let rows = [];
        for (const selector of rowSelectors) {
          try {
            rows = await page.locator(selector).all();
            if (rows.length > 0) break;
          } catch (e) {
            continue;
          }
        }
        
        const rowTexts = [];
        for (let i = 0; i < Math.min(10, rows.length); i++) {
          try {
            const text = await rows[i].innerText();
            rowTexts.push(`Row ${i+1}: ${text.substring(0, 100)}...`);
          } catch (e) {
            rowTexts.push(`Row ${i+1}: Error reading`);
          }
        }
        
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Worker: Found ${rows.length} rows on ${regUrl}:\n${rowTexts.join('\n')}`
        });
        
        // Scoped row search - exact match first
        let targetRow = null;
        let selectorUsed = null;
        
        try {
          // Try multiple ancestor patterns for different row types
          const ancestorPatterns = ["tr[1]", ".views-row[1]", ".row[1]", ".program-row[1]", ".event-row[1]"];
          
          for (const pattern of ancestorPatterns) {
            try {
              targetRow = page.locator(`text=${targetText}`).first().locator(`xpath=ancestor::${pattern}`);
              if (await targetRow.isVisible()) {
                await supabase.from('plan_logs').insert({
                  plan_id,
                  msg: `Worker: Found target row using ancestor pattern: ${pattern}`
                });
                break;
              }
            } catch (e) {
              continue;
            }
          }
        } catch (e) {
          // Try partial match fallback
        }
        
        // Try to click register button within the target row
        if (targetRow) {
          try {
            for (const selector of REGISTER_SELECTORS) {
              try {
                // Check if button exists in target row
                const button = targetRow.locator(selector).first();
                if (await button.count() > 0) {
                  // Log scroll attempt
                  await supabase.from('plan_logs').insert({
                    plan_id,
                    msg: `Worker: Trying to scroll into view for selector ${selector}`
                  });
                  
                  // Use helper to scroll until visible and click
                  try {
                    const visibleButton = await scrollUntilVisible(page, selector);
                    await visibleButton.click();
                    selectorUsed = selector;
                    
                    await supabase.from('plan_logs').insert({
                      plan_id,
                      msg: `Worker: Clicked exact match using selector: ${selector}`
                    });
                    break;
                  } catch (scrollError) {
                    await supabase.from('plan_logs').insert({
                      plan_id,
                      msg: `Worker: Failed to scroll ${selector}: ${scrollError.message}`
                    });
                  }
                }
              } catch (e) {
                continue;
              }
            }
          } catch (e) {
            // Continue to fallbacks
          }
        }
        
        // Fallback 1: Partial match with "Nordic Kids"
        if (!selectorUsed) {
          try {
            const partialRow = page.locator('text=/Nordic Kids/i').first().locator("xpath=ancestor::tr[1]");
            if (await partialRow.isVisible()) {
              for (const selector of REGISTER_SELECTORS) {
                try {
                  const button = partialRow.locator(selector).first();
                  if (await button.count() > 0) {
                    // Log scroll attempt
                    await supabase.from('plan_logs').insert({
                      plan_id,
                      msg: `Worker: Trying to scroll into view for selector ${selector} (partial match)`
                    });
                    
                    // Use helper to scroll until visible and click
                    try {
                      const visibleButton = await scrollUntilVisible(page, selector);
                      await visibleButton.click();
                      selectorUsed = selector;
                      
                      await supabase.from('plan_logs').insert({
                        plan_id,
                        msg: `Worker: Clicked partial match (Nordic Kids) using selector: ${selector}`
                      });
                      break;
                    } catch (scrollError) {
                      await supabase.from('plan_logs').insert({
                        plan_id,
                        msg: `Worker: Failed to scroll ${selector}: ${scrollError.message}`
                      });
                    }
                  }
                } catch (e) {
                  continue;
                }
              }
            }
          } catch (e) {
            // Continue to global fallback
          }
        }
        
        // Fallback 2: Global click attempt
        if (!selectorUsed) {
          for (const selector of REGISTER_SELECTORS) {
            try {
              // Log scroll attempt
              await supabase.from('plan_logs').insert({
                plan_id,
                msg: `Worker: Trying to scroll into view for selector ${selector} (global fallback)`
              });
              
              // Use helper to scroll until visible and click
              try {
                const visibleButton = await scrollUntilVisible(page, selector);
                await visibleButton.click();
                selectorUsed = selector;
                
                await supabase.from('plan_logs').insert({
                  plan_id,
                  msg: `Worker: Clicked global fallback using selector: ${selector}`
                });
                break;
              } catch (scrollError) {
                await supabase.from('plan_logs').insert({
                  plan_id,
                  msg: `Worker: Failed to scroll ${selector}: ${scrollError.message}`
                });
              }
            } catch (e) {
              continue;
            }
          }
        }
        
        // Check if click was successful
        if (selectorUsed) {
          // Wait for URL to change to /registration/*/start
          try {
            await page.waitForURL(/\/registration\/.*\/start/, { timeout: 10000 });
            const startUrl = page.url();
            
            await supabase.from('plan_logs').insert({
              plan_id,
              msg: `Worker: Successfully navigated to registration start: ${startUrl}`
            });
            
            return { success: true, startUrl: startUrl };
            
          } catch (e) {
            // Check if we're on a registration form page
            await page.waitForLoadState('networkidle', { timeout: 5000 });
            const currentUrl = page.url();
            
            if (currentUrl.includes('registration') && !currentUrl.includes('/events')) {
              return { success: true, startUrl: currentUrl };
            }
          }
        }
        
      } catch (pageError) {
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Worker: Error on page ${regUrl}: ${pageError.message}`
        });
      }
    }
    
    // If we get here, all attempts failed
    const lastRows = await page.locator('.views-row, tr').all();
    const lastRowTexts = [];
    for (let i = 0; i < Math.min(5, lastRows.length); i++) {
      try {
        const text = await lastRows[i].innerText();
        lastRowTexts.push(text.substring(0, 100));
      } catch (e) {
        lastRowTexts.push("Error reading row");
      }
    }
    
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `BLACKHAWK_DISCOVERY_FAILED - Last 5 rows:\n${lastRowTexts.join('\n')}`
    });
    
    return { 
      success: false, 
      error: `Target program "${targetText}" not found after trying all registration pages`, 
      code: "BLACKHAWK_DISCOVERY_FAILED" 
    };
    
  } catch (error) {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `BLACKHAWK_DISCOVERY_FAILED - Error: ${error.message}`
    });
    
    return { 
      success: false, 
      error: error.message, 
      code: "BLACKHAWK_DISCOVERY_FAILED" 
    };
  }
}

// ===== EXISTING SIGNUP EXECUTION FUNCTIONS =====

async function executeSignup(page, plan, credentials, nordicColorGroup, nordicRental, volunteer, allowNoCvv, supabase) {
  const plan_id = plan.id;
  
  try {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: "Worker: Starting signup execution with advanced anti-bot measures"
    });

    // Navigate to registration page with deterministic timing
    const baseUrl = plan.base_url || `https://${(plan.org||'').toLowerCase().replace(/[^a-z0-9]/g,'')}.skiclubpro.team`;
    const registrationUrl = `${baseUrl}/registration`;
    
    await page.goto(registrationUrl, { waitUntil: 'networkidle' });
    
    // Wait for Antibot form to unhide controls
    try {
      await page.waitForSelector('form.antibot', { timeout: 15000 });
    } catch (e) {
      // Antibot may not exist on all sites
    }
    
    // Use the new robust Blackhawk discovery function
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: "Worker: Using Blackhawk discovery function for program registration"
    });
    
    const discoveryResult = await discoverBlackhawkRegistration(page, plan, supabase);
    
    if (discoveryResult.success) {
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker: Program discovery successful, proceeding to fill form at: ${discoveryResult.startUrl}`
      });
      
      // Wait for registration form to load
      await page.waitForLoadState('networkidle');
      
      // Fill out registration form
      const formResult = await fillRegistrationForm(page, plan, credentials, nordicColorGroup, nordicRental, volunteer, allowNoCvv, supabase);
      return formResult;
      
    } else {
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker: Program discovery failed: ${discoveryResult.error}`
      });
      
      // Set plan status to action_required to keep session alive  
      await supabase.from('plans').update({ status: 'action_required' }).eq('id', plan_id);
      
      return {
        success: false,
        requiresAction: true,
        message: `Program discovery failed: ${discoveryResult.error}. Session kept alive for manual assistance.`
      };
    }

  } catch (error) {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Signup execution error: ${error.message}`
    });
    
    return {
      success: false,
      message: `Signup execution failed: ${error.message}`
    };
  }
}

async function fillRegistrationForm(page, plan, credentials, nordicColorGroup, nordicRental, volunteer, allowNoCvv, supabase) {
  const plan_id = plan.id;
  
  try {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: "Worker: Filling registration form with human-like behavior"
    });

    // Advanced form field detection and filling
    const formFields = {
      'input[name*="first_name"], input[id*="first"], input[placeholder*="first" i]': plan.child_name?.split(' ')[0] || '',
      'input[name*="last_name"], input[id*="last"], input[placeholder*="last" i]': plan.child_name?.split(' ').slice(1).join(' ') || '',
      'input[name*="email"], input[type="email"]': credentials.email,
      'input[name*="phone"], input[type="tel"]': plan.phone || '',
      'select[name*="grade"], select[id*="grade"]': plan.grade || '',
      'textarea[name*="emergency"], textarea[id*="emergency"]': plan.emergency_contact || ''
    };

    for (const [selector, value] of Object.entries(formFields)) {
      if (value) {
        try {
          const field = page.locator(selector).first();
          if (await field.isVisible()) {
            await advancedSimulateMouseMovement(page, field);
            await field.click();
            await advancedHumanizedDelay(getWeightedRandomDelay(500, 1500));
            
            if (selector.includes('select')) {
              await field.selectOption({ label: value });
            } else {
              await field.clear();
              await advancedHumanizedType(page, field, value);
            }
            
            await advancedHumanizedDelay(getWeightedRandomDelay(500, 1000));
          }
        } catch (e) {
          // Continue with next field
        }
      }
    }

    // Handle special options (Nordic rental, color group, volunteer)
    if (nordicRental !== null) {
      await handleNordicRental(page, nordicRental, supabase, plan_id);
    }
    
    if (nordicColorGroup !== null) {
      await handleNordicColorGroup(page, nordicColorGroup, supabase, plan_id);
    }
    
    if (volunteer !== null) {
      await handleVolunteerOption(page, volunteer, supabase, plan_id);
    }

    // Handle payment information
    if (credentials.cvv || allowNoCvv) {
      await handlePaymentInfo(page, credentials, allowNoCvv, supabase, plan_id);
    }

    // Submit form
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: "Worker: Submitting registration form"
    });

    const submitButton = page.locator('input[type="submit"], button[type="submit"], button:has-text("Submit"), button:has-text("Register")').first();
    
    if (await submitButton.isVisible()) {
      await advancedSimulateMouseMovement(page, submitButton);
      await advancedHumanizedDelay(getWeightedRandomDelay(1000, 3000));
      await submitButton.click();
      
      // Wait for submission result
      await advancedHumanizedDelay(getWeightedRandomDelay(5000, 8000));
      
      // Check for success or errors
      const currentUrl = page.url();
      const content = await page.content();
      
      if (currentUrl.includes('success') || content.includes('successfully registered') || content.includes('registration complete')) {
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: "Worker: ✅ Registration completed successfully"
        });
        
        return { success: true, message: "Registration completed successfully" };
      } else if (content.includes('error') || content.includes('failed') || content.includes('invalid')) {
        const errorMsg = "Registration failed - please check form data";
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Worker: Registration failed: ${errorMsg}`
        });
        
        return { success: false, message: errorMsg };
      } else {
        // Ambiguous result - may require manual verification
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: "Worker: Registration submitted - manual verification may be required"
        });
        
        return { 
          success: false, 
          requiresAction: true, 
          message: "Registration submitted but requires manual verification" 
        };
      }
    } else {
      return { success: false, message: "Submit button not found" };
    }

  } catch (error) {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Form filling error: ${error.message}`
    });
    
    return { success: false, message: `Form filling failed: ${error.message}` };
  }
}

async function handleNordicRental(page, nordicRental, supabase, plan_id) {
  try {
    const rentalSelectors = [
      'input[name*="rental"], input[id*="rental"]',
      'select[name*="rental"], select[id*="rental"]',
      'input[value*="rental" i]'
    ];
    
    for (const selector of rentalSelectors) {
      const element = page.locator(selector).first();
      if (await element.isVisible()) {
        if (selector.includes('select')) {
          await element.selectOption({ label: nordicRental });
        } else if (selector.includes('input[type="checkbox"]') || selector.includes('input[type="radio"]')) {
          if (nordicRental.toLowerCase().includes('yes') || nordicRental.toLowerCase().includes('true')) {
            await element.check();
          }
        }
        break;
      }
    }
  } catch (e) {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Nordic rental handling error: ${e.message}`
    });
  }
}

async function handleNordicColorGroup(page, nordicColorGroup, supabase, plan_id) {
  try {
    const colorSelectors = [
      'select[name*="color"], select[id*="color"]',
      'select[name*="group"], select[id*="group"]',
      'input[name*="color"], input[id*="color"]'
    ];
    
    for (const selector of colorSelectors) {
      const element = page.locator(selector).first();
      if (await element.isVisible()) {
        if (selector.includes('select')) {
          await element.selectOption({ label: nordicColorGroup });
        } else {
          await element.fill(nordicColorGroup);
        }
        break;
      }
    }
  } catch (e) {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Nordic color group handling error: ${e.message}`
    });
  }
}

async function handleVolunteerOption(page, volunteer, supabase, plan_id) {
  try {
    const volunteerSelectors = [
      'input[name*="volunteer"], input[id*="volunteer"]',
      'select[name*="volunteer"], select[id*="volunteer"]',
      'input[value*="volunteer" i]'
    ];
    
    for (const selector of volunteerSelectors) {
      const element = page.locator(selector).first();
      if (await element.isVisible()) {
        if (selector.includes('select')) {
          await element.selectOption({ label: volunteer });
        } else if (selector.includes('input[type="checkbox"]') || selector.includes('input[type="radio"]')) {
          if (volunteer.toLowerCase().includes('yes') || volunteer.toLowerCase().includes('true')) {
            await element.check();
          }
        }
        break;
      }
    }
  } catch (e) {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Volunteer option handling error: ${e.message}`
    });
  }
}

async function handlePaymentInfo(page, credentials, allowNoCvv, supabase, plan_id) {
  try {
    // Look for CVV field
    const cvvSelectors = [
      'input[name*="cvv"], input[id*="cvv"]',
      'input[name*="security"], input[id*="security"]',
      'input[placeholder*="cvv" i], input[placeholder*="security" i]'
    ];
    
    for (const selector of cvvSelectors) {
      const cvvField = page.locator(selector).first();
      if (await cvvField.isVisible()) {
        if (credentials.cvv) {
          await advancedSimulateMouseMovement(page, cvvField);
          await cvvField.click();
          await advancedHumanizedDelay(getWeightedRandomDelay(500, 1000));
          await advancedHumanizedType(page, cvvField, credentials.cvv);
          
          await supabase.from('plan_logs').insert({
            plan_id,
            msg: "Worker: CVV entered"
          });
        } else if (!allowNoCvv) {
          await supabase.from('plan_logs').insert({
            plan_id,
            msg: "Worker: CVV required but not provided"
          });
          throw new Error("CVV required but not provided");
        }
        break;
      }
    }
  } catch (e) {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Payment info handling error: ${e.message}`
    });
    throw e;
  }
}

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Worker listening on 0.0.0.0:${PORT} with enhanced infrastructure and advanced anti-bot measures`);
});
