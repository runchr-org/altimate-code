#!/bin/bash
# Run the Verdaccio-based sanity suite: build → publish to local registry → npm install -g → test
# This tests the EXACT same flow a real user goes through with `npm install -g altimate-code`
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "========================================"
echo "  Verdaccio Sanity Suite"
echo "  Tests the real npm install -g flow"
echo "  Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "========================================"
echo ""

# Ensure binaries are built
if [ ! -d "$REPO_ROOT/packages/opencode/dist/@altimateai" ]; then
  echo "ERROR: No built binary found at packages/opencode/dist/@altimateai/"
  echo "  Run: cd packages/opencode && bun run build"
  exit 1
fi
if [ ! -f "$REPO_ROOT/packages/dbt-tools/dist/index.js" ]; then
  echo "ERROR: dbt-tools not built at packages/dbt-tools/dist/index.js"
  echo "  Run: cd packages/dbt-tools && bun run build"
  exit 1
fi

# Clean up on exit
cleanup() {
  echo ""
  echo "Cleaning up Docker containers..."
  docker compose -f "$SCRIPT_DIR/docker-compose.verdaccio.yml" down --volumes --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

# Run the suite (disable errexit so we capture the exit code for summary)
set +e
docker compose -f "$SCRIPT_DIR/docker-compose.verdaccio.yml" up \
  --build \
  --abort-on-container-exit \
  --exit-code-from sanity
EXIT_CODE=$?
set -e

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "  VERDACCIO SANITY: ALL PASSED"
else
  echo "  VERDACCIO SANITY: FAILED (exit $EXIT_CODE)"
fi

exit $EXIT_CODE
