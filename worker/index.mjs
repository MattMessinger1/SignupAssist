// --- Error guards to surface startup issues ---
process.on("unhandledRejection", (reason) => {
  console.error("🔥 Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🔥 Uncaught Exception:", err);
});

console.log("🚀 Worker starting…");

import express from "express";

const app = express();
app.use(express.json());

// Simple health check (no envs required)
app.get("/health", (_req, res) => {
  console.log("⚡ /health");
  res.json({ ok: true });
});

// Create Browserbase session (lazy import Playwright so startup never crashes)
app.post("/run-plan", async (req, res) => {
  const plan_id = req.body?.plan_id ?? "unknown";
  console.log("📡 /run-plan", { plan_id });

  const bbKey = process.env.BROWSERBASE_API_KEY || "";
  const bbProj = process.env.BROWSERBASE_PROJECT_ID || "";

  if (!bbKey || !bbProj) {
    const missing = {
      BROWSERBASE_API_KEY: !bbKey,
      BROWSERBASE_PROJECT_ID: !bbProj,
    };
    console.error("❌ Missing env(s):", missing);
    return res.status(500).json({ ok: false, code: "MISSING_ENV", missing, plan_id });
  }

  try {
    const { chromium } = await import("playwright-core").catch((e) => {
      console.error("❌ Failed to import playwright-core:", e);
      throw new Error("PLAYWRIGHT_IMPORT_FAILED");
    });
    void chromium; // prove module loads

    console.log("📡 Creating Browserbase session…");
    const resp = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BB-API-Key": bbKey,
      },
      body: JSON.stringify({
        projectId: bbProj,
        keepAlive: true,
      }),
    });

    const text = await resp.text();
    console.log("🔎 Browserbase status:", resp.status, "body:", text.slice(0, 400));

    if (!resp.ok) {
      return res.status(502).json({
        ok: false,
        code: "BROWSERBASE_CREATE_FAILED",
        status: resp.status,
        body: text,
        plan_id,
      });
    }

    const data = JSON.parse(text);
    return res.json({ ok: true, sessionId: data.id, plan_id });
  } catch (err) {
    console.error("❌ /run-plan error:", err);
    return res.status(500).json({ ok: false, code: "UNEXPECTED_ERROR", error: String(err), plan_id });
  }
});

// Bind to Railway's assigned PORT (fallback 8080)
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Worker listening on 0.0.0.0:${PORT}`);
});
