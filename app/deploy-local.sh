#!/bin/sh
# Build the site and (re)start it on this machine as one production process. The database and the
# object store have to be running (in the repository root: docker compose up -d postgres storage).
#
#   ./deploy-local.sh          build, stop the running copy if any, start, wait until it answers
#   ./deploy-local.sh stop     stop it
#
# Serves http://127.0.0.1:${PORT:-8787}. Workspaces in ${FDEGYM_DATA:-~/.fdegym-app}; the log and the
# process id are kept there (server.log, server.pid). It runs until stopped or the machine restarts.
set -e
cd "$(dirname "$0")"
DATA="${FDEGYM_DATA:-$HOME/.fdegym-app}"
PORT="${PORT:-8787}"
mkdir -p "$DATA"
# Settings for this machine only (for example FDEGYM_DATABASE_URL) are kept in $DATA/env, one
# NAME=value per line, outside the repository.
if [ -f "$DATA/env" ]; then set -a; . "$DATA/env"; set +a; fi

stop() {
  if [ -f "$DATA/server.pid" ] && kill -0 "$(cat "$DATA/server.pid")" 2>/dev/null; then
    kill "$(cat "$DATA/server.pid")"
    echo "stopped $(cat "$DATA/server.pid")"
  fi
  rm -f "$DATA/server.pid"
}

if [ "$1" = "stop" ]; then stop; exit 0; fi

pnpm build
stop
PORT="$PORT" API_PORT="$PORT" NODE_ENV=production nohup pnpm exec tsx server/index.ts >> "$DATA/server.log" 2>&1 &
echo $! > "$DATA/server.pid"
for i in $(seq 1 40); do
  if curl -fs "http://127.0.0.1:$PORT/api/cases" > /dev/null 2>&1; then
    echo "FDE Gym is up at http://127.0.0.1:$PORT (pid $(cat "$DATA/server.pid"), log $DATA/server.log)"
    exit 0
  fi
  sleep 0.5
done
echo "the server did not answer; see $DATA/server.log" >&2
tail -20 "$DATA/server.log" >&2
exit 1
