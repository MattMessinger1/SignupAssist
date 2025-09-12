// Error guards
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

// Health check
app.get("/health", (req, res) => {
  console.log("⚡ Health check hit");
  res.json({ ok: true });
});

// Browserbase run-plan
app.post("/run-plan", async (req, res) => {
  const plan_id = req.body?.plan_id || "unknown";
  console.log("📡 /run-plan hit with plan_id:", plan_id);

  try {
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

    console.log("📡 Browserbase response status:", bbResp.status);

    if (!bbResp.ok) throw new Error("Failed to create Browserbase session");

    const session = await bbResp.json();
    console.log("✅ Browserbase session created:", session.id);

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