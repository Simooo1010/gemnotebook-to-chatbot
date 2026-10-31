#!/usr/bin/env bash
# Starts the fake Supabase emulator (port 3410) and `next start` (port 3300) in production mode for docs/qa/walkthrough-prod.mjs.
# Needs a built app (`npm run build`), a gitignored .env.local (OWNER_PASSPHRASE, MASTER_SECRET, CRON_SECRET, PUBLIC_BASE_URL=http://localhost:3300)
# and a gitignored .env.sbkey.local (FAKE_SB_KEY=<synthetic>). Logs go to $QA_LOGS (default /tmp/qa-logs). Prints the two PIDs; stop them by PID.
set -euo pipefail
cd "$(dirname "$0")/../.."
LOGS="${QA_LOGS:-/tmp/qa-logs}"; mkdir -p "$LOGS"
set -a; source .env.sbkey.local; set +a
FAKE_SB_PORT=3410 FAKE_SB_KEY="$FAKE_SB_KEY" nohup node docs/qa/fake-supabase.mjs >"$LOGS/emulator.log" 2>&1 &
echo $! >"$LOGS/emulator.pid"; echo "emulator pid $!"
sleep 1
SUPABASE_URL=http://127.0.0.1:3410 SUPABASE_SERVICE_ROLE_KEY="$FAKE_SB_KEY" NODE_ENV=production \
  nohup node node_modules/next/dist/bin/next start -p 3300 >"$LOGS/server.log" 2>&1 &
echo $! >"$LOGS/server.pid"; echo "server pid $!"
