process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("🔥 Uncaught Exception:", err);
});

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

app.post("/run-plan", async (req, res) => {
  const plan_id = req.body?.plan_id || "unknown";
  console.log("📡 /run-plan hit with plan_id:", plan_id);

  try {
    console.log("🗄️ Attempting Supabase insert: worker: received job");
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Log that worker received the job
    await supabase.from('plan_logs').insert({
      plan_id: plan_id,
      msg: 'Worker received job'
    });

    console.log("🔑 Using Browserbase project:", process.env.BROWSERBASE_PROJECT_ID);

    console.log("📡 Creating Browserbase session…");
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

    console.log("📡 Waiting for Browserbase response…");
    console.log("📡 Browserbase response status:", bbResp.status);

    if (!bbResp.ok) throw new Error("Failed to create Browserbase session");

    const session = await bbResp.json();
    console.log("✅ Browserbase session created:", session.id);

    console.log("🗄️ Logging Browserbase session to Supabase…");
    await supabase.from('plan_logs').insert({
      plan_id: plan_id,
      msg: `Browserbase session created: ${session.id}`
    });

    console.log("✅ Browserbase session complete, responding to client.");
    res.json({ ok: true, sessionId: session.id, plan_id });
  } catch (err) {
    console.error("❌ Error in /run-plan:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Worker listening on 0.0.0.0:${PORT}`);
});