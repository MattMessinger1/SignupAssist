import express from "express";
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

app.post("/run-plan", async (req, res) => {
  const plan_id = req.body?.plan_id || "unknown";
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    await supabase.from("plan_logs").insert({ plan_id, msg: "worker: received job" });

    // 1) Create Browserbase session
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

    // 2) Connect Playwright to remote Chromium over CDP
    const browser = await chromium.connectOverCDP(session.connectUrl);
    const ctx = browser.contexts()[0] ?? await browser.newContext();
    const page = ctx.pages()[0] ?? await ctx.newPage();

    await page.goto("https://example.com");
    await supabase.from("plan_logs").insert({ plan_id, msg: "worker: navigated to example.com" });

    await browser.close();
    res.json({ ok: true, sessionId: session.id });
  } catch (err) {
    console.error(err);
    await supabase.from("plan_logs").insert({ plan_id, msg: "worker: ERROR " + String(err?.message ?? err) });
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`worker listening on :${port}`));
