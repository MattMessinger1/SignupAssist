#!/usr/bin/env bash
set -euo pipefail

echo "Deploying Supabase Edge Functions…"
cd supabase/functions

for d in */ ; do
  name="${d%/}"
  [[ "$name" == "_shared" ]] && continue
  if ls "$name"/index.* >/dev/null 2>&1; then
    echo "→ Deploying: $name"
    supabase functions deploy "$name"
  fi
done

echo "✅ Done."