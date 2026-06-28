#!/usr/bin/env bash
# Gated deploy for ImmoSnap. Unit tests must pass BEFORE the live restart;
# E2E smoke runs against the new build AFTER. Run: npm run deploy
set -euo pipefail
cd /home/claude/immosnap-pwa
export PM2_HOME=/home/claude/.pm2

echo "── [1/4] unit tests (gate) ───────────────"
if ! npm test; then
  echo "✖ unit tests FAILED — aborting deploy. Live build untouched."
  exit 1
fi
echo "✓ unit tests pass"

echo "── [2/4] restart via PM2 ─────────────────"
npx pm2 restart immosnap --update-env >/dev/null
npx pm2 save >/dev/null
echo "✓ restarted"

echo "── [3/4] health check ────────────────────"
ok=0
for i in $(seq 1 15); do
  if curl -fsS --max-time 4 http://localhost:3001/ >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] && echo "✓ serving on :3001" || { echo "✖ origin not healthy after restart"; exit 1; }

echo "── [4/4] E2E smoke (real browser + GPS) ──"
if npm run e2e; then
  echo "✓ DEPLOY OK — unit + e2e green, live"
else
  echo "⚠ DEPLOY WARNING — server is live but E2E failed. Investigate before demo."
  exit 2
fi
