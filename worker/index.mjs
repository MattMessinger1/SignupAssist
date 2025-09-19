console.log("🚀 Worker starting up...");
console.log("📦 Importing dependencies...");
import express from "express";
console.log("✅ Express imported");
import { createClient } from "@supabase/supabase-js";
console.log("✅ Supabase client imported");
import { chromium } from "playwright-core";
console.log("✅ Playwright imported");
import { pickAdapter } from './adapters/registry.js';
console.log("✅ Adapter registry imported");

console.log("🔍 Checking environment variables...");
const requiredStartupEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY', 
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'CRED_ENC_KEY'
];

const missingStartupEnvVars = requiredStartupEnvVars.filter(varName => !process.env[varName]);
if (missingStartupEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingStartupEnvVars);
  console.error('Available env vars:', Object.keys(process.env).filter(key => key.includes('SUPABASE') || key.includes('BROWSERBASE') || key.includes('CRED')));
} else {
  console.log("✅ All required environment variables present");
}

// ===== SHARED HELPER FUNCTIONS =====
/**
 * Scrolls until a selector becomes visible or throws after max attempts
 * @param page Playwright page instance
 * @param selector CSS selector to find and scroll to
 * @param maxScrolls Maximum number of scroll attempts (default: 20)
 * @returns The visible element
 * @throws Error if element not found or not visible after maxScrolls
 */
async function scrollUntilVisible(page, selector, maxScrolls = 24) {
  for (let i = 0; i < maxScrolls; i++) {
    const el = page.locator(selector).first();
    if (await el.count()) {
      try {
        await el.scrollIntoViewIfNeeded();
        await el.waitFor({ state: "visible", timeout: 1500 });
        return el;
      } catch {}
    }
    await page.mouse.wheel(0, 550);
    await page.waitForTimeout(120);
  }
  throw new Error(`Element not visible for selector: ${selector}`);
}

async function ensureAuthenticated(page, baseUrl, email, password, supabase, plan_id) {
  // Always perform a real login unless we can prove we're authenticated
  await page.goto(`${baseUrl}/user/login`, { waitUntil: "networkidle" });

  // If already logged in, /user/login may redirect or show "Logout"
  const url = page.url();
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';

  const looksLoggedIn = url.includes('/user/dashboard') ||
                        /logout|sign out/i.test(bodyText);

  if (!looksLoggedIn) {
    // Perform login
    await page.waitForSelector('#edit-name', { timeout: 15000 });
    await page.fill('#edit-name', email);
    await page.fill('#edit-pass', password);
    await page.click('#edit-submit');
    await page.waitForLoadState('networkidle');

    // Verify by checking for dashboard or presence of an SESS cookie
    const cookies = await page.context().cookies();
    const hasDrupalSess = cookies.some(c => /S?SESS/i.test(c.name));
    const postLoginUrl = page.url();
    const postLoginText = (await page.locator('body').innerText().catch(() => '')) || '';

    if (!hasDrupalSess && !postLoginUrl.includes('/user') && !/logout|sign out/i.test(postLoginText)) {
      await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: Login verification failed' });
      throw new Error('LOGIN_VERIFICATION_FAILED');
    }
  }

  await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: Authenticated session verified' });
}

async function openProgramsFromSidebar(page, baseUrl, supabase, plan_id) {
  // Guardrail: Never re-open sidebar on /registration
  if (/\/registration$/.test(page.url())) {
    await supabase.from('plan_logs').insert({ 
      plan_id, 
      msg: 'Worker: Skipping sidebar expansion - already on /registration page' 
    });
    return;
  }

  try { await page.setViewportSize({ width: 1280, height: 900 }); } catch {}

  // Expand sidebar/hamburger/collapsible Register section if needed
  const toggles = [
    'button[aria-label*="menu" i]',
    '.navbar-toggle, .menu-toggle, .offcanvas-toggle',
    '#block-register .collapsible-block-action, [data-once*="collapsiblock"] .collapsible-block-action'
  ];
  for (const sel of toggles) {
    const t = page.locator(sel).first();
    if (await t.count()) { await t.click().catch(()=>{}); await page.waitForTimeout(250); }
  }

  // Click "Programs" (DOM matches your screenshot: a.nav-link--registration[href="/registration"])
  const candidates = [
    'nav a.nav-link--registration:has-text("Programs")',
    'a[href="/registration"]:has-text("Programs")',
    '#block-register a[href="/registration"]',
    'nav[aria-label*="register" i] a:has-text("Programs")'
  ];
  let clicked = false;
  for (const sel of candidates) {
    const link = page.locator(sel).first();
    if (await link.count()) {
      await supabase.from('plan_logs').insert({ plan_id, msg: `Worker: Clicking Programs via ${sel}` });
      await link.scrollIntoViewIfNeeded().catch(()=>{});
      await link.click().catch(()=>{});
      clicked = true;
      break;
    }
  }

  // Land on /registration; if not, navigate directly (auth is verified)
  if (!clicked || !/\/registration$/.test(page.url())) {
    await page.goto(`${baseUrl}/registration`, { waitUntil: 'networkidle' });
  }

  // If redirected to login anyway, re-auth once and retry /registration
  if (page.url().includes('/user/login')) {
    await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: Redirected to login from /registration; re-authenticating' });
    // NOTE: pass creds at callsite
    throw new Error('REAUTH_AND_RETRY_REGISTRATION');
  }

  // Assert the Programs list is present
  await page.waitForLoadState("networkidle");
  await page.waitForSelector('table, .views-row, .view, section', { timeout: 15000 });
}

console.log("🛡️ Setting up error handlers...");
process.on('uncaughtException', async (error) => {
  console.error('🚨 Uncaught Exception:', error);
  console.error('Stack trace:', error.stack);
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
  process.exit(1);
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
      msg: `CRITICAL ERROR: Unhandled Promise Rejection: ${reason}`
    });
  } catch (e) {
    console.error('Failed to log unhandled rejection:', e);
  }
  process.exit(1);
});

console.log("🚀 Creating Express app...");
const app = express();
console.log("✅ Express app created");
app.use(express.json());
console.log("✅ JSON middleware added");

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
  console.log("⚡ Health check hit from:", req.get('User-Agent') || 'unknown');
  console.log("🏥 Health check - app is running properly");
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    env: {
      NODE_ENV: process.env.NODE_ENV || 'unknown',
      PORT: process.env.PORT || '8080'
    }
  });
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
      
      // Use new robust authentication helper
      await ensureAuthenticated(page, normalizedBaseUrl, credentials.email, credentials.password, supabase, plan_id);

      // Open Programs from sidebar (or direct) to reach the list
      try {
        await openProgramsFromSidebar(page, normalizedBaseUrl, supabase, plan_id);
      } catch (e) {
        if (String(e).includes('REAUTH_AND_RETRY_REGISTRATION')) {
          await ensureAuthenticated(page, normalizedBaseUrl, credentials.email, credentials.password, supabase, plan_id);
          await page.goto(`${normalizedBaseUrl}/registration`, { waitUntil: 'networkidle' });
        } else { 
          throw e; 
        }
      }

      // Now wait for listing to be ready
      await page.waitForSelector('.views-row, table, .row, .program, .event', { timeout: 15000 });
      await page.waitForLoadState('networkidle');

      // Continue with signup execution...
      const signupResult = await executeSignup(page, plan, credentials, nordicColorGroup, nordicRental, volunteer, allowNoCvv, supabase);
      
      // Update plan status based on result
      if (signupResult.success) {
        await supabase
          .from('plans')
          .update({ status: 'completed' })
          .eq('id', plan_id);
        
        // Only log success after real success is detected
        if (!signupResult.requiresAction) {
          await supabase.from('plan_logs').insert({
            plan_id,
            msg: `Worker: ✅ Plan execution completed successfully`
          });
        }
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

// Helper function for detailed failure logging
async function selectParticipant(page, fullName) {
  // Try native <select> first
  const nativeSel = page.locator('select#edit-field-participant, select[name*="participant"]');
  if (await nativeSel.count()) {
    await nativeSel.first().selectOption({ label: fullName }).catch(async () => {
      // fallback: select by value or partial
      const options = await nativeSel.first().locator('option').allTextContents();
      const best = options.find(t => t.toLowerCase().includes(fullName.toLowerCase()));
      if (!best) throw new Error(`Participant "${fullName}" not found`);
      await nativeSel.first().selectOption({ label: best });
    });
    return true;
  }

  // Chosen.js fallback (matches your screenshots)
  const chosen = page.locator('.chosen-container-single .chosen-single');
  if (await chosen.count()) {
    await chosen.first().click();
    const search = page.locator('.chosen-search input');
    if (await search.count()) {
      await search.fill(fullName);
      // chosen drops results in .chosen-results li
      const li = page.locator('.chosen-results li').filter({ hasText: new RegExp(fullName, 'i') }).first();
      await li.click();
      return true;
    }
  }
  return false;
}

async function clickNextLike(page) {
  const next = page.locator(
    '#edit-submit, button#edit-submit,' +               // Start/Options common
    'button:has-text("Next"), button:has-text("Continue"),' +
    '#edit-actions-next, button#edit-actions-next,' +   // Checkout → Review
    'input[type="submit"][value*="Next" i], input[type="submit"][value*="Continue" i]'
  ).first();
  if (!(await next.count())) return false;
  await next.scrollIntoViewIfNeeded().catch(()=>{});
  await next.click();
  await page.waitForLoadState('networkidle');
  return true;
}

async function clickNextAndWaitForChange(page, urlRegexesToDetectNext) {
  const beforeUrl = page.url();
  const clicked = await clickNextLike(page);
  if (!clicked) return { changed:false, reason:'NO_NEXT_BUTTON' };

  const changed = await Promise.race([
    page.waitForFunction(prev => location.href !== prev, beforeUrl, { timeout: 4000 }).then(()=>true).catch(()=>false),
    (async () => {
      await page.waitForTimeout(400);
      return urlRegexesToDetectNext.some(r => r.test(page.url()));
    })()
  ]);

  return { changed, reason: changed ? 'STATE_CHANGED' : 'NO_STATE_CHANGE' };
}

async function clickNext(page) {
  const next = page.locator(
    '#edit-submit, button#edit-submit, button:has-text("Next"), button:has-text("Continue"), input[type="submit"][value*="Next"], input[type="submit"][value*="Continue"]'
  ).first();
  if (!(await next.count())) return false;
  await next.scrollIntoViewIfNeeded().catch(()=>{});
  await next.click();
  await page.waitForLoadState('networkidle');
  return true;
}

async function at(urlRe) { return (loc) => urlRe.test(loc); }

function isSuccess(url, body) {
  return /\/checkout\/.+\/complete/.test(url) ||
         /(thank you|registration complete|successfully registered)/i.test(body);
}

async function logMessages(page, supabase, plan_id, where) {
  const msgSel = '.messages--error, .messages--warning, .alert-danger, .alert-warning, [role="alert"]';
  const txt = await page.locator(msgSel).innerText().catch(()=>'');

  if (txt?.trim()) {
    await supabase.from('plan_logs').insert({ plan_id, msg: `Worker: ${where} messages: ${txt.slice(0,400)}` });
  }
}

function sawSuccess(url, bodyText) {
  return /\/checkout\/.+\/complete/.test(url) ||
         /(thank you|registration complete|successfully registered|order number)/i.test(bodyText);
}

function looksLikeDonationLabel(t='') {
  const s = t.toLowerCase();
  return /donat(e|ion)|tip|contribution|gift|support|fund/i.test(s);
}

function looksLikeOptionalLabel(t='') {
  const s = t.toLowerCase();
  return /optional|add[-\s]*on|addon|extra|upsell|volunteer/i.test(s);
}

function isSuccess(url, body) {
  return /\/checkout\/.+\/complete/.test(url) ||
         /(thank you|registration complete|successfully registered|order number)/i.test(body);
}

async function logMessages(page, supabase, plan_id, where) {
  const sel = '.messages--error, .messages--warning, .alert-danger, .alert-warning, [role="alert"]';
  const txt = await page.locator(sel).innerText().catch(()=> '');
  if (txt?.trim()) {
    await supabase.from('plan_logs').insert({ plan_id, msg: `Worker: ${where} messages: ${txt.slice(0,400)}` });
  }
}

function looksLikeOptionalLabel(t='') {
  const s = t.toLowerCase();
  return /optional|add[-\s]*on|addon|extra|upsell|volunteer/i.test(s);
}

async function setNumericInputToZero(scope) {
  const nums = scope.locator('input[type="number"], input[type="text"][inputmode="numeric"], input[pattern*="\\d"]');
  const n = await nums.count();
  for (let i = 0; i < n; i++) {
    const el = nums.nth(i);
    const name = (await el.getAttribute('name')) || '';
    const id   = (await el.getAttribute('id')) || '';
    const label = await scope.locator(`label[for="${id}"]`).innerText().catch(()=>'');

    if (looksLikeDonationLabel(name) || looksLikeDonationLabel(id) || looksLikeDonationLabel(label)) {
      await el.fill('0');
    }
  }
}

async function uncheckDonationCheckboxes(scope) {
  const cbs = scope.locator('input[type="checkbox"]');
  const n = await cbs.count();
  for (let i = 0; i < n; i++) {
    const el = cbs.nth(i);
    const id = (await el.getAttribute('id')) || '';
    const name = (await el.getAttribute('name')) || '';
    const label = await scope.locator(`label[for="${id}"]`).innerText().catch(()=>'');

    if (looksLikeDonationLabel(name) || looksLikeDonationLabel(id) || looksLikeDonationLabel(label)) {
      if (await el.isChecked()) await el.uncheck().catch(()=>{});
    }
  }
}

async function selectNoThanksOrZero(scope) {
  // Handle select dropdowns with "No thanks/None/$0"
  const selects = scope.locator('select');
  const n = await selects.count();
  for (let i = 0; i < n; i++) {
    const sel = selects.nth(i);
    const id = (await sel.getAttribute('id')) || '';
    const name = (await sel.getAttribute('name')) || '';
    const label = await scope.locator(`label[for="${id}"]`).innerText().catch(()=>'');

    const opts = sel.locator('option');
    const texts = await opts.allTextContents().catch(()=>[]);
    const lower = texts.map(t => t.toLowerCase());

    // For donation-like selects, force $0 / none
    if (looksLikeDonationLabel(name) || looksLikeDonationLabel(id) || looksLikeDonationLabel(label)) {
      let idx = lower.findIndex(t => /\$?\s*0(\.00)?|none|no thanks|not now|skip/i.test(t));
      if (idx < 0 && texts.length) idx = 0; // last resort
      if (idx >= 0) await sel.selectOption({ index: idx }).catch(()=>{});
      continue;
    }

    // For optional/upsell selects, prefer a non-charging choice
    if (looksLikeOptionalLabel(label) || looksLikeOptionalLabel(name)) {
      let idx = lower.findIndex(t => /\$?\s*0(\.00)?|none|no thanks|not required/i.test(t));
      if (idx < 0 && texts.length) idx = 0;
      if (idx >= 0) await sel.selectOption({ index: idx }).catch(()=>{});
    }
  }
}

// One call to sanitize a page section - scoped to main content only
async function suppressDonationsAndPickFree(scope, supabase, plan_id, where) {
  let changesMade = false;
  try {
    // Count changes to avoid unnecessary updates
    const numsBefore = await scope.locator('input[type="number"], input[type="text"][inputmode="numeric"], input[pattern*="\\d"]').count();
    await setNumericInputToZero(scope);
    
    const cbsBefore = await scope.locator('input[type="checkbox"]:checked').count();
    await uncheckDonationCheckboxes(scope);
    
    const selectsBefore = await scope.locator('select').count();
    await selectNoThanksOrZero(scope);
    
    // Log exactly what we changed
    const changes = [];
    if (numsBefore > 0) changes.push(`set ${numsBefore} numeric fields to 0`);
    if (cbsBefore > 0) changes.push(`unchecked ${cbsBefore} donation checkboxes`);
    if (selectsBefore > 0) changes.push(`selected no-cost options in ${selectsBefore} selects`);
    
    if (changes.length > 0) {
      changesMade = true;
      await supabase.from('plan_logs').insert({ plan_id, msg: `Worker: Donation/optional fields sanitized on ${where}: ${changes.join(', ')}` });
    }
  } catch (e) {
    await supabase.from('plan_logs').insert({ plan_id, msg: `Worker: Donation sanitize error on ${where}: ${e.message}` });
  }
  return changesMade;
}

async function logDiscoveryFailure(page, plan_id, error, code, supabase) {
  try {
    const currentUrl = page.url();
    
    // Log current URL
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `DISCOVERY FAILURE - Current URL: ${currentUrl} | Error: ${error}`
    });
    
    // Capture first 8 table rows specifically for debugging  
    const tableRowsDebug = [];
    try {
      const tableRows = page.locator('tbody tr, table tr').filter({
        has: page.locator('td, th')
      });
      const rowCount = await tableRows.count();
      
      for (let i = 0; i < Math.min(8, rowCount); i++) {
        const rowText = await tableRows.nth(i).innerText().catch(() => '');
        tableRowsDebug.push(`Row ${i+1}: ${rowText.substring(0, 200).replace(/\n/g, ' ')}`);
      }
    } catch (e) {
      tableRowsDebug.push(`Error capturing table rows: ${e.message}`);
    }
    
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `DISCOVERY FAILURE - First 8 table rows:\n${tableRowsDebug.join('\n')}`
    });
    
    // Capture full-page screenshot
    try {
      const screenshot = await page.screenshot({ fullPage: true });
      const base64Screenshot = screenshot.toString('base64');
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `DISCOVERY FAILURE - Screenshot: data:image/png;base64,${base64Screenshot}`
      });
    } catch (screenshotError) {
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `DISCOVERY FAILURE - Screenshot capture failed: ${screenshotError.message}`
      });
    }
    
  } catch (logError) {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `DISCOVERY FAILURE - Error during failure logging: ${logError.message} | Original Error: ${error}`
    });
  }
  
  return { success: false, error, code, url: currentUrl };
}

async function discoverBlackhawkRegistration(page, plan, credentials, allowNoCvv, supabase) {
  const plan_id = plan.id;
  
  try {
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: "Worker: Starting Blackhawk program discovery with adapter-based strategy"
    });

    const baseUrl = plan.base_url || `https://${(plan.org||'').toLowerCase().replace(/[^a-z0-9]/g,'')}.skiclubpro.team`;
    const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
    
    // Early guard: never re-open sidebar once on /registration
    if (/\/registration$/.test(page.url())) {
      await supabase.from('plan_logs').insert({ 
        plan_id, 
        msg: 'Worker: Already on /registration — skipping sidebar and proceeding to list parsing' 
      });
      // ensure we do NOT run any sidebar expansion/toggling from this point
    } else {
      // Check for login redirect and handle immediately
      if (/\/user\/login\?destination=/.test(page.url())) {
        await supabase.from('plan_logs').insert({
          plan_id,
          msg: `Worker: Detected login redirect at ${page.url()}, authenticating and going to /registration`
        });
        await ensureAuthenticated(page, normalizedBaseUrl, credentials.email, credentials.password, supabase, plan_id);
      }
      
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker: Navigating from ${page.url()} to ${normalizedBaseUrl}/registration`
      });
      await page.goto(`${normalizedBaseUrl}/registration`, { waitUntil: 'networkidle' });
    }
    await page.waitForLoadState('networkidle');
    
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Ensured we're on registration page: ${page.url()}`
    });
    
    // Verify authentication before proceeding
    const hasLoginForm = await page.locator('input[type="password"], input[name="password"], #edit-pass').count() > 0;
    const isAuthenticated = await page.locator('a[href*="logout"], .user-menu, .dashboard-content, [class*="authenticated"]').count() > 0;
    
    if (hasLoginForm || !isAuthenticated) {
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker: Authentication check failed - login form present: ${hasLoginForm}, auth indicators: ${isAuthenticated}`
      });
      throw new Error('Session authentication failed - redirected to login');
    }
    
    // Optional search filter to reduce noise
    const search = page.locator('input[type="search"], input[name*="search"], input[placeholder*="search" i]').first();
    if (await search.count()) {
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: 'Worker: Found search filter, applying "Nordic" filter'
      });
      await search.fill('Nordic');
      await page.keyboard.press('Enter').catch(()=>{});
      const apply = page.locator('button:has-text("Search"), button:has-text("Apply"), input[type="submit"]');
      if (await apply.count()) await apply.first().click().catch(()=>{});
      await page.waitForLoadState('networkidle');
    }

    // Use adapter system to detect layout and find program
    const adapter = await pickAdapter(page);
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Selected adapter for layout detection`
    });
    
    await adapter.openListing(page, normalizedBaseUrl);
    
    // Build matcher for the program
    const NAME = /nordic kids wednesday/i;
    
    const {container, layout} = await adapter.findProgramContainer(page, NAME);
    if (!container) {
      // Log first 8 containers' text then fail
      const samples = await page.locator('tbody tr, .views-row, .card, article').allTextContents().catch(()=>[]);
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Worker: No container matched "Nordic Kids Wednesday" using ${layout} layout. Sample blocks: ${JSON.stringify((samples||[]).slice(0,8))}`
      });
      return { success:false, error:'No matching program rows', code:'BLACKHAWK_DISCOVERY_FAILED' };
    }

    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: Found program container using ${layout} layout, clicking register button`
    });

    // Row-scoped click using adapter
    try {
      await adapter.clickRegisterInContainer(page, container);
      await page.waitForURL(/\/registration\/\d+\/start/, { timeout: 15000 });
      await supabase.from('plan_logs').insert({ plan_id, msg: `Worker: Start page opened: ${page.url()}` });
      
      // === Complete registration flow with state machine ===
      await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: Entering advance loop' });

      const MAX_HOPS = 12;
      for (let hop=0; hop<MAX_HOPS; hop++) {
        const url = page.url();
        const body = (await page.locator('body').innerText().catch(()=>'')) || '';

        if (isSuccess(url, body)) {
          await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: Success detected — registration complete' });
          return { success:true, requiresAction:false, details:{ message:'Signup completed' } };
        }

        if (/\/registration\/\d+\/start/.test(url)) {
          await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: On Start — ensure participant selected then Next' });
          const child = (plan.child_name || '').trim();
          const ok = await selectParticipant(page, child);
          if (!ok) {
            await supabase.from('plan_logs').insert({ plan_id, msg: `Worker: Participant "${child}" not selectable` });
            return { success:false, error:`Participant "${child}" not selectable`, code:'PARTICIPANT_NOT_FOUND' };
          }
          const res = await clickNextAndWaitForChange(page, [/\/registration\/\d+\/options/, /\/cart(\?|$)/, /\/checkout\/\d+/]);
          if (!res.changed) {
            await logMessages(page, supabase, plan_id, 'Start post-Next');
            return { success:true, requiresAction:true, details:{ message:`Stuck on Start (${res.reason})` } };
          }
          continue;
        }

        if (/\/registration\/\d+\/options/.test(url)) {
          await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: On Options — fill required & skip donations' });

          // Ensure required selects are set to a non-placeholder choice
          const req = page.locator('select[required], select.js-form-required');
          const n = await req.count();
          for (let i=0; i<n; i++){
            const sel = req.nth(i);
            const val = await sel.inputValue().catch(()=> '');
            if (!val || /none|select|choose/i.test(val)) {
              const options = await sel.locator('option').allTextContents().catch(()=> []);
              const idx = options.findIndex(t => t && !/^\s*(-\s*none\s*-|select|choose)/i.test(t));
              if (idx > 0) await sel.selectOption({ index: idx }).catch(()=>{});
              await supabase.from('plan_logs').insert({ plan_id, msg: `Worker: Required select set to "${options[idx] || 'first non-empty'}"` });
            }
          }

          await suppressDonationsAndPickFree(page.locator('main'), supabase, plan_id, 'Options');

          const res = await clickNextAndWaitForChange(page, [/\/cart(\?|$)/, /\/checkout\/\d+/]);
          if (!res.changed) {
            await logMessages(page, supabase, plan_id, 'Options post-Next');
            return { success:true, requiresAction:true, details:{ message:`Stuck on Options (${res.reason})` } };
          }
          continue;
        }

        if (/\/cart(\?|$)/.test(url)) {
          await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: On Cart — clean donations, Checkout' });
          const changed = await suppressDonationsAndPickFree(page.locator('main'), supabase, plan_id, 'Cart');
          if (changed) {
            const update = page.locator('button:has-text("Update cart"), input[type="submit"][value*="Update" i]').first();
            if (await update.count()) { await update.click().catch(()=>{}); await page.waitForLoadState('networkidle'); }
          }
          const checkoutBtn = page.locator('#edit-checkout, button#edit-checkout, button:has-text("Checkout")').first();
          if (await checkoutBtn.count()) { await checkoutBtn.scrollIntoViewIfNeeded().catch(()=>{}); await checkoutBtn.click(); await page.waitForLoadState('networkidle'); continue; }
          await logMessages(page, supabase, plan_id, 'Cart — no checkout button');
          return { success:true, requiresAction:true, details:{ message:'Stuck on Cart' } };
        }

        if (/\/checkout\/\d+\/(installments|payment)/.test(url) || /\/checkout\/\d+($|\?)/.test(url)) {
          await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: On Checkout — prefer saved payment' });
          const saved = page.locator('input[type="radio"][name*="payment"][value*="saved"], input[type="radio"][name*="payment-method"]').first();
          if (await saved.count()) { await saved.check().catch(()=>{}); }
          else {
            const hasCardForm = await page.locator('input[name*="cardnumber"], iframe[src*="card"], input[autocomplete="cc-number"]').count();
            if (hasCardForm && !allowNoCvv) {
              await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: Full card form present — action required' });
              return { success:true, requiresAction:true, details:{ message:'Payment requires manual card entry' } };
            }
          }
          const cont = page.locator('button:has-text("Continue to Review"), #edit-actions-next').first();
          if (await cont.count()) { await cont.scrollIntoViewIfNeeded().catch(()=>{}); await cont.click(); await page.waitForLoadState('networkidle'); continue; }
          await logMessages(page, supabase, plan_id, 'Checkout — no continue');
          return { success:true, requiresAction:true, details:{ message:'Stuck on Checkout' } };
        }

        if (/\/checkout\/\d+\/review/.test(url)) {
          await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: On Review — Pay and complete' });
          const pay = page.locator('button:has-text("Pay and complete purchase"), #edit-actions-next').first();
          if (await pay.count()) { await pay.scrollIntoViewIfNeeded().catch(()=>{}); await pay.click(); await page.waitForLoadState('networkidle'); continue; }
          await logMessages(page, supabase, plan_id, 'Review — no pay button');
          return { success:true, requiresAction:true, details:{ message:'Stuck on Review' } };
        }

        // Unknown state → try one generic Next; if no change, stop
        await logMessages(page, supabase, plan_id, `Hop ${hop} on ${url}`);
        const res = await clickNextAndWaitForChange(page, [/\/cart(\?|$)/, /\/checkout\/\d+/, /\/checkout\/\d+\/review/, /\/checkout\/.+\/complete/]);
        if (!res.changed) break;
      }

      await supabase.from('plan_logs').insert({ plan_id, msg: 'Worker: Could not confirm success — action required (advance loop ended)' });
      return { success:true, requiresAction:true, details:{ message:'Submitted or mid-flow; needs quick manual confirm' } };
    } catch (e) {
      await supabase.from('plan_logs').insert({
        plan_id, msg: `Worker: Register click failed: ${e.message}`
      });
      return { success:false, error:'Register click failed', code:'BLACKHAWK_DISCOVERY_FAILED' };
    }
  
  } catch (error) {
    console.error("Discovery error:", error);
    return await logDiscoveryFailure(page, plan_id, error.message, 'BLACKHAWK_DISCOVERY_FAILED', supabase);
  }
}

// ===== EXISTING SIGNUP EXECUTION FUNCTIONS =====

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
    
    const discoveryResult = await discoverBlackhawkRegistration(page, plan, credentials, allowNoCvv, supabase);
    
    // One-run guarantee: return the discovery result immediately
    // No legacy form filling should run after adapter-based discovery
    if (discoveryResult.success !== undefined) {
      // Discovery completed with definitive result
      return discoveryResult;
    }
    
    // This should never happen with proper discovery implementation
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Worker: CRITICAL - Discovery returned undefined result, failing safely`
    });
    
    return {
      success: false,
      requiresAction: true,
      message: 'Discovery system error - manual assistance required'
    };

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
console.log("🌐 Starting server...");
const PORT = process.env.PORT || 8080;
console.log(`📡 Attempting to listen on 0.0.0.0:${PORT}`);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Worker listening on 0.0.0.0:${PORT} with enhanced infrastructure and advanced anti-bot measures`);
  console.log("🎉 Server startup complete!");
});
