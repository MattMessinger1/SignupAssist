console.log("🚀 Worker starting up...");
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  console.log("⚡ Health check hit");
  res.json({ ok: true });
});

// Run-plan endpoint
app.post("/run-plan", async (req, res) => {
  const plan_id = req.body?.plan_id || "unknown";
  console.log(`🎯 /run-plan request for plan_id: ${plan_id}`);

  if (!plan_id) {
    return res.status(400).json({ error: "plan_id is required" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    await supabase.from("plan_logs").insert({ plan_id, msg: "worker: received job" });

    // Create Browserbase session
    const bbResp = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BB-API-Key": process.env.BROWSERBASE_API_KEY
      },
      body: JSON.stringify({
        projectId: process.env.BROWSERBASE_PROJECT_ID,
        keepAlive: true
      })
    });

    if (!bbResp.ok) throw new Error("Failed to create Browserbase session");
    const session = await bbResp.json();
    await supabase.from("plan_logs").insert({ plan_id, msg: `worker: session ${session.id}` });

    // Connect Playwright to remote browser
    const browser = await chromium.connectOverCDP(session.connectUrl);
    const ctx = browser.contexts()[0] ?? await browser.newContext();
    const page = ctx.pages()[0] ?? await ctx.newPage();

    await page.goto("https://example.com");
    await supabase.from("plan_logs").insert({ plan_id, msg: "worker: navigated to example.com" });

    await browser.close();

    res.json({ ok: true, sessionId: session.id, plan_id });
  } catch (err) {
    console.error("❌ Error in /run-plan:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Worker listening on 0.0.0.0:${PORT}`);
});
