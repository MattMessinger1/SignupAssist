console.log("🚀 Worker starting up...");
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json());

// Environment validation
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'CRED_ENC_KEY'
];

console.log("🔍 Checking environment variables...");
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
  } else {
    console.log(`✅ Found ${envVar}`);
  }
}

// Health check
app.get("/health", (req, res) => {
  console.log("⚡ Health check hit");
  res.json({ ok: true });
});

// Run plan endpoint with Browserbase integration
app.post("/run-plan", async (req, res) => {
  const { plan_id } = req.body;
  console.log(`🎯 Run-plan request received for plan_id: ${plan_id}`);

  if (!plan_id) {
    console.log("❌ Missing plan_id in request");
    return res.status(400).json({ error: "plan_id is required" });
  }

  try {
    // Initialize Supabase client
    console.log("🔌 Initializing Supabase client...");
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Fetch plan details
    console.log(`📋 Fetching plan details for ${plan_id}...`);
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('*')
      .eq('id', plan_id)
      .single();

    if (planError) {
      console.error("❌ Error fetching plan:", planError);
      return res.status(404).json({ error: "Plan not found" });
    }

    console.log(`✅ Plan fetched: ${plan.title} (${plan.status})`);

    // Check plan status
    if (!['scheduled', 'action_required'].includes(plan.status)) {
      console.log(`⚠️ Plan status ${plan.status} not eligible for execution`);
      return res.status(400).json({ 
        error: `Plan status '${plan.status}' is not eligible for execution` 
      });
    }

    // Get credentials
    console.log("🔐 Fetching credentials...");
    const { data: credResponse, error: credError } = await supabase.functions.invoke('cred-get', {
      body: { plan_id }
    });

    if (credError || !credResponse?.credentials) {
      console.error("❌ Error fetching credentials:", credError);
      return res.status(500).json({ error: "Failed to fetch credentials" });
    }

    const { email, password, cvv } = credResponse.credentials;
    console.log(`✅ Credentials fetched for email: ${email}`);

    // Create Browserbase session
    console.log("🌐 Creating Browserbase session...");
    const sessionResponse = await fetch("https://www.browserbase.com/v1/sessions", {
      method: "POST",
      headers: {
        "X-BB-API-Key": process.env.BROWSERBASE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: process.env.BROWSERBASE_PROJECT_ID,
      }),
    });

    if (!sessionResponse.ok) {
      const errorText = await sessionResponse.text();
      console.error("❌ Browserbase session creation failed:", errorText);
      return res.status(500).json({ error: "Failed to create browser session" });
    }

    const session = await sessionResponse.json();
    console.log(`✅ Browserbase session created: ${session.id}`);

    let browser;
    let result = { success: false };

    try {
      // Connect to Browserbase
      console.log("🔗 Connecting to Browserbase...");
      browser = await chromium.connectOverCDP(
        `wss://connect.browserbase.com?apiKey=${process.env.BROWSERBASE_API_KEY}&sessionId=${session.id}`
      );

      const context = browser.contexts()[0];
      const page = await context.newPage();

      console.log(`🎯 Navigating to: ${plan.login_url}`);
      await page.goto(plan.login_url);

      // Login process
      console.log("🔑 Starting login process...");
      await page.fill('input[type="email"]', email);
      await page.fill('input[type="password"]', password);
      await page.click('button[type="submit"]');
      await page.waitForLoadState('networkidle');

      console.log("✅ Login completed");

      // Navigate to signup URL if different
      if (plan.signup_url && plan.signup_url !== plan.login_url) {
        console.log(`🎯 Navigating to signup URL: ${plan.signup_url}`);
        await page.goto(plan.signup_url);
        await page.waitForLoadState('networkidle');
      }

      // Execute signup process (simplified for now)
      console.log("📝 Executing signup process...");
      
      // Look for name fields and fill them
      if (plan.child_name) {
        const nameSelectors = [
          'input[name*="name"]',
          'input[placeholder*="name"]',
          'input[id*="name"]'
        ];
        
        for (const selector of nameSelectors) {
          const element = await page.$(selector);
          if (element) {
            await element.fill(plan.child_name);
            console.log(`✅ Filled name field: ${selector}`);
            break;
          }
        }
      }

      // Fill CVV if required
      if (cvv) {
        const cvvSelectors = [
          'input[name*="cvv"]',
          'input[name*="cvc"]',
          'input[placeholder*="CVV"]',
          'input[placeholder*="CVC"]'
        ];
        
        for (const selector of cvvSelectors) {
          const element = await page.$(selector);
          if (element) {
            await element.fill(cvv);
            console.log(`✅ Filled CVV field: ${selector}`);
            break;
          }
        }
      }

      // Look for submit button
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Submit")',
        'button:has-text("Register")',
        'button:has-text("Sign up")'
      ];

      let submitted = false;
      for (const selector of submitSelectors) {
        const element = await page.$(selector);
        if (element) {
          await element.click();
          console.log(`✅ Clicked submit button: ${selector}`);
          submitted = true;
          break;
        }
      }

      if (submitted) {
        await page.waitForLoadState('networkidle');
        
        // Check for success indicators
        const currentUrl = page.url();
        const pageContent = await page.textContent('body');
        
        if (pageContent.toLowerCase().includes('success') || 
            pageContent.toLowerCase().includes('confirmation') ||
            currentUrl.includes('success') || 
            currentUrl.includes('confirmation')) {
          result = { 
            success: true, 
            message: "Signup completed successfully",
            final_url: currentUrl
          };
          console.log("🎉 Signup appears successful");
        } else if (pageContent.toLowerCase().includes('email') && 
                   pageContent.toLowerCase().includes('confirm')) {
          result = { 
            success: false, 
            action_required: true,
            message: "Email confirmation required",
            final_url: currentUrl
          };
          console.log("📧 Email confirmation required");
        } else {
          result = { 
            success: false, 
            message: "Signup outcome unclear",
            final_url: currentUrl,
            page_content: pageContent.substring(0, 500)
          };
          console.log("⚠️ Signup outcome unclear");
        }
      } else {
        result = { 
          success: false, 
          message: "Could not find submit button" 
        };
        console.log("❌ Could not find submit button");
      }

    } finally {
      if (browser) {
        console.log("🧹 Closing browser connection...");
        await browser.close();
      }
    }

    // Update plan status
    console.log("💾 Updating plan status...");
    const newStatus = result.success ? 'completed' : 
                     result.action_required ? 'action_required' : 'failed';
    
    await supabase
      .from('plans')
      .update({ 
        status: newStatus,
        last_run: new Date().toISOString()
      })
      .eq('id', plan_id);

    console.log(`✅ Plan status updated to: ${newStatus}`);

    res.json({
      success: true,
      plan_id,
      execution_result: result,
      status: newStatus
    });

  } catch (error) {
    console.error("💥 Unhandled error in run-plan:", error);
    
    // Try to update plan status to failed
    try {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      );
      
      await supabase
        .from('plans')
        .update({ 
          status: 'failed',
          last_run: new Date().toISOString()
        })
        .eq('id', plan_id);
    } catch (updateError) {
      console.error("❌ Failed to update plan status:", updateError);
    }

    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
      plan_id
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Worker listening on 0.0.0.0:${PORT}`);
});