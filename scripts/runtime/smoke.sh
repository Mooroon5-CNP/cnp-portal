#!/bin/sh
# No network, credentials or app secrets. Run on each supported Node version.
set -eu
node scripts/runtime/start.cjs node -e 'if (process.argv[1] !== "original-argument") process.exit(1)' original-argument
node scripts/runtime/start.cjs python3 -c 'import sys; assert sys.argv[1] == "original-argument"' original-argument
if node scripts/runtime/start.cjs node -e 'process.exit(23)'; then
  exit 1
else
  result=$?
  test "$result" -eq 23
fi
node scripts/runtime/start.cjs node -e 'setInterval(() => {}, 1000)' &
loader_pid=$!
sleep 1
kill -TERM "$loader_pid"
if wait "$loader_pid"; then
  exit 1
else
  result=$?
  test "$result" -eq 143
fi
