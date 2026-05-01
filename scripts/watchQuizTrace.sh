#!/usr/bin/env bash
#
# Watch quiz-generation trace events.
#
# Two modes:
#
#   1. LIVE — start the dev server with QUIZ_TRACE=1 and stream the
#      events to your terminal as they happen. Full log is also saved
#      to a timestamped file so you can re-read it later.
#
#         scripts/watchQuizTrace.sh
#
#      Then open http://localhost:5000 in another tab and generate
#      a quiz. Trace events will appear in this shell as they fire.
#      Press Ctrl-C to stop the server when done.
#
#   2. REPLAY — read trace events from a saved log file. Use this
#      when you've already captured a session and just want to look
#      through the events.
#
#         scripts/watchQuizTrace.sh quiz-trace-20260501-153122.log
#
# Pretty-printing: each event is a JSON-tagged log line. By default
# this script just shows the raw lines (one per event). Pipe through
# `jq -R 'split(" | ") | {time: .[0][13:36], event: (.[0]|capture("event=(?<n>\\S+)").n), data: (.[1]|fromjson)}'` if you have jq installed for fully-parsed output.
#
# Note for deployed (production) traces: this script reads from a
# local dev-server run, NOT from Replit's deployed app. To see trace
# events from the deployed app, set QUIZ_TRACE=1 in Replit Secrets,
# republish, then open the Deployments → Logs tab in the Replit UI
# and search for "QUIZ_TRACE". There is no shell-only way to read
# Replit deployment logs without their CLI.

set -euo pipefail

# ── Mode 2: replay an existing log ──────────────────────────────────
if [ "$#" -ge 1 ] && [ -f "$1" ]; then
  echo "Replaying QUIZ_TRACE events from: $1"
  echo "─────────────────────────────────────────────────────────────"
  grep --color=auto "QUIZ_TRACE" "$1" || {
    echo "(no QUIZ_TRACE events found — was QUIZ_TRACE=1 set when this log was captured?)"
    exit 1
  }
  exit 0
fi

# ── Mode 1: live tail ──────────────────────────────────────────────
LOG_FILE="quiz-trace-$(date +%Y%m%d-%H%M%S).log"

echo "Starting dev server with QUIZ_TRACE=1"
echo "Full log:  $LOG_FILE"
echo "App URL:   http://localhost:5000"
echo "Filter:    only [QUIZ_TRACE] events shown below"
echo "Stop:      Ctrl-C"
echo "─────────────────────────────────────────────────────────────"
echo ""

# tee the full server output to a log file so you don't lose anything,
# then filter only QUIZ_TRACE lines for the live view. --line-buffered
# is a GNU grep flag that flushes on every line so you don't wait for
# a buffer to fill before seeing the events.
QUIZ_TRACE=1 npm run dev 2>&1 \
  | tee "$LOG_FILE" \
  | grep --line-buffered "QUIZ_TRACE"
