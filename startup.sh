#!/bin/sh
set -e

echo "==> CNP Portal — startup"

# Check .env exists
if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy .env.example and fill in your GitLab OAuth credentials."
  exit 1
fi

# Check required vars
check_var() {
  val=$(grep "^$1=" .env | cut -d= -f2-)
  if [ -z "$val" ] || echo "$val" | grep -q "REPLACE_WITH"; then
    echo "ERROR: $1 is not set in .env"
    exit 1
  fi
}

check_var GITLAB_HOST
check_var GITLAB_CLIENT_ID
check_var GITLAB_CLIENT_SECRET
check_var SESSION_SECRET

# Install deps if needed
if [ ! -d node_modules ]; then
  echo "==> Installing dependencies..."
  npm install
fi

echo "==> Starting CNP Portal on http://localhost:${PORT:-3000}"
exec node src/index.js
