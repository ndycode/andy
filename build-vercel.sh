#!/usr/bin/env bash
# Build for Vercel using the Build Output API (.vercel/output).
# Bypasses framework auto-detection: we hand Vercel a pre-bundled, self-contained function.
set -euo pipefail
cd "$(dirname "$0")"

OUT=.vercel/output
rm -rf "$OUT"
mkdir -p "$OUT/functions/api.func" "$OUT/static"

# Bundle the Hono app + all workspace/npm deps into one file.
bun build api/index.ts --target=node --format=esm \
  --outfile="$OUT/functions/api.func/index.mjs"

# Function config (Node 22, Singapore region + generous timeout). maxDuration 300s (the plan max)
# gives the retry/fallback chain ample headroom; runAgent ALSO self-bounds with an AbortSignal well
# under this, so a slow run aborts cleanly into the catch (marker stays 'claimed', retryable) rather
# than getting hard-killed by the platform (which skips the catch and strands the marker → 504s).
cat > "$OUT/functions/api.func/.vc-config.json" <<'JSON'
{
  "runtime": "nodejs22.x",
  "handler": "index.mjs",
  "launcherType": "Nodejs",
  "shouldAddHelpers": true,
  "maxDuration": 300,
  "regions": ["sin1"]
}
JSON

# Static landing page.
cp public/index.html "$OUT/static/index.html"

# Top-level output config: route everything to the function, keep cron + region.
# Cron at 00:07 UTC = 08:07 Manila — a minute off the contended :00 slot (the daily tick
# self-heals the weekly recap via summary_runs, so exact minute is not load-bearing).
cat > "$OUT/config.json" <<'JSON'
{
  "version": 3,
  "routes": [
    { "src": "/(.*)", "dest": "/api" }
  ],
  "crons": [
    { "path": "/api/cron/weekly-summary", "schedule": "7 0 * * *" }
  ]
}
JSON

echo "Build Output API artifacts ready in $OUT"
