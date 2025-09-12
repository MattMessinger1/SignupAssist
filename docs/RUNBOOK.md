# SignupAssist Runbook

## 1. Health Check

* **Endpoint**: `/health`
* **Expected Response**: `{ "ok": true }`
* **Verification**: Railway runtime logs should show `⚡ Health check hit` whenever this endpoint is called.

## 2. Core Dependencies

The worker depends on several environment variables, all of which must be set in Railway service variables:

* `SUPABASE_URL`
* `SUPABASE_SERVICE_ROLE_KEY`
* `BROWSERBASE_API_KEY`
* `BROWSERBASE_PROJECT_ID`
* `CRED_ENC_KEY`

## 3. Worker Lifecycle

* Startup log should show: `🚀 Worker starting up...`
* Bind log should show: `✅ Worker listening on 0.0.0.0:8080`
* If the container is crashing, Railway will show repeated `Starting Container` → `Stopping Container` cycles.

## 4. Testing

### Health

```bash
curl https://signupassist-production.up.railway.app/health
```

Expected response:

```json
{ "ok": true }
```

### Run-Plan

```bash
export SRK=<your_service_role_key>

curl -i -X POST https://signupassist-production.up.railway.app/run-plan \
  -H "Authorization: Bearer $SRK" \
  -H "Content-Type: application/json" \
  -d '{ "plan_id": "<uuid>" }'
```

* Expected: JSON response (and rows written to `plan_logs`).

## 5. Failure Modes

* **Crash Loop**: Usually caused by unhandled promise rejection in `index.mjs`. Wrap all async code in `try/catch`.
* **502 on /health**: Worker isn’t alive, or wrong Dockerfile is being used.
* **Browserbase errors**: Verify API keys and quotas, check Playwright connection errors.

## 6. Recovery Steps

1. **Rollback to Dummy `/run-plan`**
   Replace logic with a simple stub returning `{ ok: true }` to keep the worker alive.

2. **Check Railway Variables**
   Verify all required env vars are set.

3. **Deploy Minimal Container**
   Test a basic `/health` endpoint only. Ensure Railway stays green before reintroducing Browserbase.

4. **Add Logging**
   Add logs at startup, health hits, and around all external API calls (Supabase, Browserbase) to surface errors.

---

This runbook is designed to give you a step-by-step way to verify, test, and recover the SignupAssist worker service as it integrates Supabase and Browserbase automation.
