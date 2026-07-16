#!/usr/bin/env bash
# Verify that closing /files/watch SSE connections releases inotify watches.
#
# Usage: ./scripts/verify-inotify-fix.sh [N]
#   N = number of SSE connections to open (default 10)

set -u
N="${1:-10}"
HOST="${HOST:-http://localhost:9777}"

if [ -z "${BACKEND_PID:-}" ]; then
  PORT=$(echo "$HOST" | sed -E 's|.*:([0-9]+).*|\1|')
  BACKEND_PID=$(ss -lntp 2>/dev/null \
    | grep ":${PORT} " \
    | grep -oE 'pid=[0-9]+' \
    | tail -1 \
    | cut -d= -f2)
  [ -z "$BACKEND_PID" ] && { echo "ERROR: nothing listening on :$PORT"; exit 2; }
fi
echo "backend pid=$BACKEND_PID"

count_inotify() {
  local pid=$1
  local n=0
  for f in /proc/"$pid"/fd/*; do
    [ "$(readlink "$f" 2>/dev/null)" = "anon_inode:inotify" ] && n=$((n + 1))
  done
  echo "$n"
}

# Auto-resolve a real session id if caller didn't supply one — the watcher
# returns an empty stream for unknown paths, which would silently make the
# test vacuous.
if [ -z "${SID:-}" ]; then
  PID0=$(curl -s "$HOST/api/v1/projects" | jq -r '.[0].id')
  SID=$(curl -s "$HOST/api/v1/projects/$PID0/sessions" | jq -r '.[0].id // empty')
  [ -z "$SID" ] && { echo "ERROR: no sessions in DB — seed one first"; exit 2; }
  echo "auto-resolved SID=$SID"
fi

# Watch URL: session-based (the frontend uses this form).
WATCH_URL="$HOST/api/v1/files/watch?session=$SID"

baseline=$(count_inotify "$BACKEND_PID")
echo "baseline inotify fds: $baseline"

pids=()
echo "opening $N SSE connections to $WATCH_URL ..."
for i in $(seq 1 "$N"); do
  curl -sN "$WATCH_URL" >/dev/null 2>&1 &
  pids+=($!)
done
sleep 2
peak=$(count_inotify "$BACKEND_PID")
echo "peak inotify fds (with $N connections open): $peak  (delta: $((peak - baseline)))"

echo "closing all connections..."
for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
wait 2>/dev/null

# Blocking task polls shutdown_rx every 250 ms; 3 s is plenty of headroom.
sleep 3
after=$(count_inotify "$BACKEND_PID")
echo "after-close inotify fds: $after  (delta vs baseline: $((after - baseline)))"

if [ "$((after - baseline))" -le 2 ]; then
  echo "PASS: inotify fds returned to baseline (leak fixed)"
else
  echo "FAIL: inotify fds did NOT return to baseline (leak still present)"
  exit 1
fi
