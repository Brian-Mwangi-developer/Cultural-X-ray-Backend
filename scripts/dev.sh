#!/usr/bin/env bash
# Brings up Redis, RabbitMQ and monitoring, waits until healthy, then runs the API and worker
# on the host with live reload. Ctrl-C stops the Node processes; containers keep running.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[[ -f .env ]] || bash scripts/init-env.sh
bash scripts/stack.sh up monitoring
pnpm exec prisma generate >/dev/null

prefix() { sed -u "s/^/[$1] /"; }
pnpm exec tsx watch --clear-screen=false src/server.ts 2>&1 | prefix api &
API=$!
pnpm exec tsx watch --clear-screen=false src/worker.ts 2>&1 | prefix worker &
WORKER=$!
trap 'kill $API $WORKER 2>/dev/null; wait 2>/dev/null' INT TERM
wait
