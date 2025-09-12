console.log("🚀 Worker starting up...");
import express from "express";

const app = express();
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Placeholder run-plan
app.post("/run-plan", (req, res) => {
  const { plan_id } = req.body;
  if (!plan_id) {
    return res.status(400).json({ error: "plan_id is required" });
  }
  res.json({ ok: true, plan_id });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Worker listening on 0.0.0.0:${PORT}`);
});