#!/bin/bash

# Cloud Search to OpenSearch Migration Tool — Setup & Run Script
# Usage:
#   bash setup_and_run.sh           Start migration in background
#   bash setup_and_run.sh --stop    Stop a running migration
#   bash setup_and_run.sh --status  Check if migration is running
#   bash setup_and_run.sh --logs    Tail the live migration log

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/migration.pid"
LOG_DIR="$SCRIPT_DIR/logs"
RUN_LOG="$LOG_DIR/migration_run.log"

# ── Helpers ──────────────────────────────────────────────────────────────────

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

# ── Sub-commands ─────────────────────────────────────────────────────────────

cmd_stop() {
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    kill "$pid"
    rm -f "$PID_FILE"
    echo "✅ Migration stopped (PID: $pid)."
  else
    echo "ℹ️  Migration is not currently running."
  fi
  exit 0
}

cmd_status() {
  if is_running; then
    echo "🟢 Migration is RUNNING (PID: $(cat "$PID_FILE"))."
    echo "📄 Tail logs: bash setup_and_run.sh --logs"
  else
    echo "🔴 Migration is NOT running."
  fi
  exit 0
}

cmd_logs() {
  if [ ! -f "$RUN_LOG" ]; then
    echo "No log file found at $RUN_LOG. Has the migration been started yet?"
    exit 1
  fi
  echo "Following $RUN_LOG (Ctrl+C to exit)..."
  tail -f "$RUN_LOG"
  exit 0
}

# ── Argument parsing ──────────────────────────────────────────────────────────

case "${1:-}" in
  --stop)   cmd_stop ;;
  --status) cmd_status ;;
  --logs)   cmd_logs ;;
  "")       ;;   # fall through to start
  *)
    echo "Unknown argument: $1"
    echo "Usage: bash setup_and_run.sh [--stop | --status | --logs]"
    exit 1
    ;;
esac

# ── Start migration ───────────────────────────────────────────────────────────

echo "========================================"
echo "  CloudSearch → OpenSearch Migration"
echo "========================================"

# Guard: don't start a second instance
if is_running; then
  echo "⚠️  Migration is already running (PID: $(cat "$PID_FILE"))."
  echo "   Run 'bash setup_and_run.sh --stop' first to stop it."
  exit 1
fi

# Load .env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
  echo "📋 Loading environment from .env ..."
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$SCRIPT_DIR/.env" | grep -v '^[[:space:]]*$' | xargs)
fi

# Set default fallbacks if not provided by .env
export MYSQL_HOST=${MYSQL_HOST:-127.0.0.1}
export MYSQL_PORT=${MYSQL_PORT:-3306}
export MYSQL_USER=${MYSQL_USER:-root}
export MYSQL_PASSWORD=${MYSQL_PASSWORD:-mysql}
export MYSQL_DATABASE=${MYSQL_DATABASE:-matters_db}

export OPENSEARCH_ENDPOINT=${OPENSEARCH_ENDPOINT:-https://localhost:9200}
export OPENSEARCH_USERNAME=${OPENSEARCH_USERNAME:-admin}
export OPENSEARCH_PASSWORD=${OPENSEARCH_PASSWORD:-admin}
export OPENSEARCH_INDEX=${OPENSEARCH_INDEX:-patent-matters}

export BATCH_SIZE=${BATCH_SIZE:-100}
export PARALLEL_WORKERS=${PARALLEL_WORKERS:-5}
export MAX_RETRIES=${MAX_RETRIES:-3}
export SLEEP_ON_429_MS=${SLEEP_ON_429_MS:-5000}
export NODE_ENV=${NODE_ENV:-dev}

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "❌ ERROR: Node.js is not installed."
  echo "   Please install Node.js from https://nodejs.org/ (v20+ recommended)."
  exit 1
fi
echo "✔  Node.js $(node -v)"

# Check npm
if ! command -v npm &>/dev/null; then
  echo "❌ ERROR: npm is not installed."
  echo "   Please install npm (usually comes with Node.js)."
  exit 1
fi
echo "✔  npm $(npm -v)"

# Install dependencies if node_modules is missing
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "📦 Installing npm dependencies..."
  npm install --prefix "$SCRIPT_DIR" --silent
  echo "✔  Dependencies installed."
else
  echo "✔  Dependencies already installed."
fi

# Run environment variable check
echo "⚙️  Validating environment configuration..."
if ! node "$SCRIPT_DIR/utils/checkEnv.js"; then
  exit 1
fi

# Ensure logs directory exists
mkdir -p "$LOG_DIR"

# Launch in background
echo ""
echo "🚀 Starting migration in background..."
nohup node --max-old-space-size=4096 "$SCRIPT_DIR/app.js" >> "$RUN_LOG" 2>&1 &
MIGRATION_PID=$!
echo "$MIGRATION_PID" > "$PID_FILE"

echo ""
echo "========================================"
echo "  Migration started ✅"
echo "========================================"
echo "  PID      : $MIGRATION_PID"
echo "  Mode     : $NODE_ENV"
echo ""
echo "  📄 Live progress  :  tail -f $RUN_LOG"
if [ "$NODE_ENV" = "prod" ]; then
echo "  📄 Migration Logs :  Stored in MySQL table 'migration_prod_logs'"
else
echo "  📄 Migrated docs  :  tail -f $LOG_DIR/migrated.log"
echo "  📄 Failed docs    :  tail -f $LOG_DIR/failed.log"
fi
echo ""
echo "  🔍 Check status   :  bash setup_and_run.sh --status"
echo "  📜 Follow logs    :  bash setup_and_run.sh --logs"
echo "  🛑 Stop migration :  bash setup_and_run.sh --stop"
echo "========================================"
