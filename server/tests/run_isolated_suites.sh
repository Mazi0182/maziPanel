#!/usr/bin/env bash
# ==============================================================================
# run_isolated_suites.sh
#
# Strict isolated QA test harness for maziPanel backend suites.
# Guarantees complete isolation from live production data, servers, and configs.
#
# Usage:
#   cd /mazideveloper/server
#   bash tests/run_isolated_suites.sh [/path/to/qa/root] [PORT]
#
# Defaults:
#   QA_ROOT: /mazideveloper/temp/qa-20261011
#   QA_PORT: 8081
# ==============================================================================

set -euo pipefail

# 1. Directory execution check
if [ ! -f "server.js" ] || [ ! -d "tests" ]; then
  echo "[ERROR] This script must be executed from the 'server' directory." >&2
  echo "        Example: cd /mazideveloper/server && bash tests/run_isolated_suites.sh" >&2
  exit 1
fi

# 2. Parameters & Strict Canonical Path Validation
RAW_QA_ROOT="${1:-/mazideveloper/temp/qa-20261011}"
QA_PORT="${2:-8081}"

# Validate and canonicalize QA_ROOT via prepare_isolated_fixtures.js
# This guarantees strict boundary checks and rejects production paths & ancestor symlinks
QA_ROOT="$(node -e "
  const { validateQaRoot } = require('./tests/prepare_isolated_fixtures');
  try {
    console.log(validateQaRoot(process.argv[1]));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
" "$RAW_QA_ROOT")"

# 3. Locate & Validate Client Dist Directory
if [ -z "${CLIENT_DIST_DIR:-}" ]; then
  # Default to own ../client/dist, never production dist
  CLIENT_DIST_DIR="$(cd ../client 2>/dev/null && pwd -P || pwd -P)/dist"
fi

# Validate physical target is not /mazideveloper/client/dist
if [ -e "$CLIENT_DIST_DIR" ]; then
  PHYSICAL_DIST="$(readlink -f "$CLIENT_DIST_DIR" 2>/dev/null || realpath "$CLIENT_DIST_DIR" 2>/dev/null || echo "$CLIENT_DIST_DIR")"
  if [ "$PHYSICAL_DIST" = "/mazideveloper/client/dist" ]; then
    echo "[ERROR] Security violation: CLIENT_DIST_DIR physical target cannot be production '/mazideveloper/client/dist'!" >&2
    exit 1
  fi
else
  mkdir -p "$CLIENT_DIST_DIR"
fi

# 4. Export Scoped QA Environment
export QA_ROOT="$QA_ROOT"
export DATA_DIR="$QA_ROOT/data"
export SERVERS_DIR="$QA_ROOT/servers"
export BACKUPS_DIR="$QA_ROOT/backups"
export TEMP_DIR="$QA_ROOT/temp"
export CLIENT_DIST_DIR="$CLIENT_DIST_DIR"
export PORT="$QA_PORT"
export TEST_PORT="$QA_PORT"
export HOST="0.0.0.0"
export TEST_HOST="127.0.0.1"
export BASE_URL="http://127.0.0.1:$QA_PORT"
export WS_URL="ws://127.0.0.1:$QA_PORT/ws"
export SINGLE_USER_MODE="false"
export NODE_ENV="test"
export TEST_MODE="true"

echo "============================================================"
echo "  maziPanel Strict Isolated QA Test Runner"
echo "============================================================"
echo "  QA Root:        $QA_ROOT"
echo "  QA Port:        $QA_PORT (HOST: 0.0.0.0)"
echo "  DATA_DIR:       $DATA_DIR"
echo "  SERVERS_DIR:    $SERVERS_DIR"
echo "  BACKUPS_DIR:    $BACKUPS_DIR"
echo "  CLIENT_DIST:    $CLIENT_DIST_DIR"
echo "============================================================"

# 5. Safe Old Daemon Termination (BEFORE rewriting fixtures)
DAEMON_LOG="$QA_ROOT/qa_daemon.log"
DAEMON_PID_FILE="$QA_ROOT/qa_daemon.pid"

stop_matched_old_daemon() {
  if [ ! -f "$DAEMON_PID_FILE" ]; then
    return 0
  fi

  local old_pid
  old_pid="$(cat "$DAEMON_PID_FILE" 2>/dev/null || true)"
  if [ -z "$old_pid" ]; then
    rm -f "$DAEMON_PID_FILE"
    return 0
  fi

  # Check if process is alive
  if ! kill -0 "$old_pid" 2>/dev/null; then
    echo "[+] Stale PID file found ($old_pid is not running). Removing $DAEMON_PID_FILE."
    rm -f "$DAEMON_PID_FILE"
    return 0
  fi

  echo "[*] Checking existing process PID $old_pid for verification..."

  local is_verified=0
  local current_server_dir
  current_server_dir="$(pwd -P)"

  if [ -d "/proc/$old_pid" ]; then
    local cmdline cwd
    cmdline="$(tr '\0' ' ' < "/proc/$old_pid/cmdline" 2>/dev/null || true)"
    cwd="$(readlink -f "/proc/$old_pid/cwd" 2>/dev/null || true)"

    if [[ "$cmdline" =~ node.*server\.js ]] && [ "$cwd" = "$current_server_dir" ]; then
      local has_data_dir=0
      local has_port=0
      if grep -z -q "^DATA_DIR=$DATA_DIR$" "/proc/$old_pid/environ" 2>/dev/null; then
        has_data_dir=1
      fi
      if grep -z -q "^PORT=$QA_PORT$" "/proc/$old_pid/environ" 2>/dev/null; then
        has_port=1
      fi

      if [ "$has_data_dir" -eq 1 ] && [ "$has_port" -eq 1 ]; then
        is_verified=1
      fi
    fi
  else
    # Fallback check if /proc not mounted
    if ps -p "$old_pid" -o command 2>/dev/null | grep -q "server\.js"; then
      is_verified=1
    fi
  fi

  if [ "$is_verified" -ne 1 ]; then
    echo "[ERROR] Process PID $old_pid in $DAEMON_PID_FILE does NOT match this isolated server (mismatched cwd/environ/cmdline)!" >&2
    echo "        Refusing to stop unrelated process. Aborting for safety." >&2
    exit 1
  fi

  echo "[+] Verified PID $old_pid matches isolated QA daemon. Stopping gracefully..."
  kill "$old_pid" 2>/dev/null || true

  # Bounded graceful wait (up to 10s)
  local stopped=0
  for i in $(seq 1 20); do
    if ! kill -0 "$old_pid" 2>/dev/null; then
      stopped=1
      break
    fi
    sleep 0.5
  done

  # Force kill only verified process if still alive
  if [ "$stopped" -ne 1 ]; then
    echo "[!] PID $old_pid did not terminate gracefully within 10s. Sending SIGKILL..."
    kill -9 "$old_pid" 2>/dev/null || true
    sleep 1
  fi

  rm -f "$DAEMON_PID_FILE"
  echo "[+] Old isolated daemon (PID: $old_pid) stopped successfully."
}

echo ""
echo "[+] Step 1: Checking and stopping verified previous daemon instance..."
stop_matched_old_daemon

# 6. Seed Isolated Fixtures (server, navigation files, zip, tar.gz archives)
echo ""
echo "[+] Step 2: Seeding isolated test fixtures..."
node tests/prepare_isolated_fixtures.js "$QA_ROOT"

# Ensure typescript module is accessible in isolated ../client for test_routing_navigation.js
if [ ! -d "../client/node_modules/typescript" ]; then
  if [ -d "/mazideveloper/client/node_modules/typescript" ]; then
    mkdir -p "../client/node_modules"
    ln -sfn "/mazideveloper/client/node_modules/typescript" "../client/node_modules/typescript" 2>/dev/null || true
  fi
fi

# 7. Start QA Daemon (with nohup, redirected I/O to survive SSH exit)
echo ""
echo "[+] Step 3: Launching isolated QA daemon on port $QA_PORT..."
nohup node server.js > "$DAEMON_LOG" 2>&1 < /dev/null &
DAEMON_PID=$!
disown "$DAEMON_PID" 2>/dev/null || true
echo "$DAEMON_PID" > "$DAEMON_PID_FILE"

# Trap failure to ensure daemon is stopped on any test error
cleanup_on_failure() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    echo ""
    echo "[!] TEST SUITE FAILED (exit code: $exit_code)!" >&2
    if [ -n "${DAEMON_PID:-}" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
      echo "[!] Stopping isolated QA daemon (PID: $DAEMON_PID)..." >&2
      kill "$DAEMON_PID" 2>/dev/null || true
      sleep 1
      kill -9 "$DAEMON_PID" 2>/dev/null || true
      rm -f "$DAEMON_PID_FILE"
    fi
  fi
}
trap cleanup_on_failure EXIT

# 8. Bounded Health Polling
echo "[+] Step 4: Polling QA daemon health (/api/health)..."
HEALTHY=0
for i in $(seq 1 60); do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "[ERROR] QA daemon process exited unexpectedly on port $QA_PORT! Recent logs:" >&2
    tail -n 40 "$DAEMON_LOG" >&2
    exit 1
  fi

  if command -v curl >/dev/null 2>&1; then
    if curl -s -f "http://127.0.0.1:$QA_PORT/api/health" >/dev/null 2>&1; then
      HEALTHY=1
      break
    fi
  else
    if node -e "
      const http = require('http');
      http.get('http://127.0.0.1:$QA_PORT/api/health', (r) => {
        process.exit(r.statusCode === 200 ? 0 : 1);
      }).on('error', () => process.exit(1));
    " 2>/dev/null; then
      HEALTHY=1
      break
    fi
  fi
  sleep 0.5
done

if [ "$HEALTHY" -ne 1 ]; then
  echo "[ERROR] Timed out waiting for QA daemon to report healthy on port $QA_PORT! Recent logs:" >&2
  tail -n 40 "$DAEMON_LOG" >&2
  exit 1
fi
echo "[+] QA daemon is healthy (PID: $DAEMON_PID)."

# 9. Run Mandatory Test Suites Sequentially
echo ""
echo "============================================================"
echo "  Executing Mandatory Test Suites (Sequentially)"
echo "============================================================"

echo ""
echo "[Suite 1/5] Running tests/test_backend.js..."
node tests/test_backend.js

echo ""
echo "[Suite 2/5] Running tests/test_all_new_features.js..."
node tests/test_all_new_features.js

echo ""
echo "[Suite 3/5] Running tests/test_backup_features.js..."
node tests/test_backup_features.js

echo ""
echo "[Suite 4/5] Running tests/verify_live_api.js..."
node tests/verify_live_api.js

echo ""
echo "[Suite 5/5] Running tests/verify_live_backups.js..."
node tests/verify_live_backups.js

# 10. Run Focused Regression Suites in Scoped QA Env
echo ""
echo "============================================================"
echo "  Executing Focused Regression Suites in Scoped QA Env"
echo "============================================================"

if [ -f "tests/test_auth_security.js" ]; then
  echo ""
  echo "[Regression Suite 1/6] Running tests/test_auth_security.js (explicit SINGLE_USER_MODE=false)..."
  SINGLE_USER_MODE="false" node tests/test_auth_security.js
fi

if [ -f "tests/test_runtime_routing_regression.js" ]; then
  echo ""
  echo "[Regression Suite 2/6] Running tests/test_runtime_routing_regression.js..."
  node tests/test_runtime_routing_regression.js
fi

if [ -f "tests/test_startup_arguments.js" ]; then
  echo ""
  echo "[Regression Suite 3/6] Running tests/test_startup_arguments.js..."
  node tests/test_startup_arguments.js
fi

if [ -f "tests/test_console_lifecycle.js" ]; then
  echo ""
  echo "[Regression Suite 4/6] Running tests/test_console_lifecycle.js..."
  node tests/test_console_lifecycle.js
fi

if [ -f "tests/test_java_installer.js" ]; then
  echo ""
  echo "[Regression Suite 5/6] Running tests/test_java_installer.js..."
  node tests/test_java_installer.js
fi

if [ -f "tests/test_routing_navigation.js" ]; then
  echo ""
  echo "[Regression Suite 6/7] Running tests/test_routing_navigation.js..."
  node tests/test_routing_navigation.js
fi

if [ -f "tests/test_module1_multiuser.js" ]; then
  echo ""
  echo "[Regression Suite 7/7] Running tests/test_module1_multiuser.js..."
  node tests/test_module1_multiuser.js
fi

# 11. Success: Disarm exit trap so QA daemon remains alive for browser inspection
trap - EXIT

echo ""
echo "============================================================"
echo "  ALL ISOLATED QA SUITES COMPLETED WITH 100% SUCCESS!"
echo "============================================================"
echo "[+] QA Daemon remains RUNNING for coordinator browser validation:"
echo "    - Access URL:  http://0.0.0.0:$QA_PORT (or http://192.168.1.110:$QA_PORT)"
echo "    - Process PID: $DAEMON_PID (recorded in $DAEMON_PID_FILE)"
echo "    - Daemon Log:  $DAEMON_LOG"
echo "    - QA Data Dir: $QA_ROOT"
echo "    - Manual Stop: kill \$(cat '$DAEMON_PID_FILE')"
echo "============================================================"
exit 0
