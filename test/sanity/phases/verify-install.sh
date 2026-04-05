#!/bin/bash
# Phase 1: Verify that npm install -g produced a working installation
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/lib/assert.sh"

echo "--- Phase 1: Verify Installation ---"

# 1. Binary linked correctly
assert_exit_0 "altimate binary available" altimate --version

# 2. Version is non-empty and looks like a version string
VERSION=$(altimate --version 2>/dev/null || echo "")
assert_contains "$VERSION" "." "version contains dot separator"

# 3. Builtin skills copied by postinstall
SKILL_COUNT=$(find ~/.altimate/builtin -name "SKILL.md" -maxdepth 2 2>/dev/null | wc -l)
SKILL_COUNT="${SKILL_COUNT:-0}"
assert_ge "$SKILL_COUNT" 17 "builtin skills installed (got $SKILL_COUNT)"

# 4. Critical skill: data-viz
assert_file_exists "$HOME/.altimate/builtin/data-viz/SKILL.md" "data-viz skill exists"

# 5. Critical skill: sql-review
assert_file_exists "$HOME/.altimate/builtin/sql-review/SKILL.md" "sql-review skill exists"

# 6. Critical skill: dbt-analyze
assert_file_exists "$HOME/.altimate/builtin/dbt-analyze/SKILL.md" "dbt-analyze skill exists"

# 7. altimate-core napi binding loads
# After npm install -g, dependencies live under the global prefix's node_modules.
# Node's require() doesn't search there by default — set NODE_PATH so the
# NAPI module (and its platform-specific optional dep) can be found.
# npm may hoist altimate-core to the global root OR nest it under
# altimate-code/node_modules/ — include both paths.
GLOBAL_NM=$(npm root -g 2>/dev/null || echo "")
AC_NM="$GLOBAL_NM/altimate-code/node_modules"
assert_exit_0 "altimate-core napi binding" env NODE_PATH="$GLOBAL_NM:$AC_NM" node -e "require('@altimateai/altimate-core')"

# 8. dbt CLI available
if command -v dbt >/dev/null 2>&1; then
  assert_exit_0 "dbt CLI available" dbt --version
else
  skip_test "dbt CLI available" "dbt not installed in this environment"
fi

# 9. git available (needed for project detection)
assert_exit_0 "git CLI available" git --version

# 10. Version matches semver format (X.Y.Z) — catches #212 regressions
VERSION_CLEAN=$(echo "$VERSION" | head -1 | tr -d '[:space:]')
if echo "$VERSION_CLEAN" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
  echo "  PASS: version is semver ($VERSION_CLEAN)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: version is not semver (got '$VERSION_CLEAN')"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# 11. --help output doesn't contain upstream "opencode" branding (#416, #417)
# Legitimate internal names (.opencode/, opencode.json, @opencode-ai/) are allowed;
# user-facing prose like "opencode is a..." or "start opencode" is not.
HELP_OUTPUT=$(altimate --help 2>&1 || echo "")
BRANDING_LEAKS=$(echo "$HELP_OUTPUT" | grep -iE 'opencode' | grep -ivE '\.opencode|opencode\.json[c]?|@opencode-ai|opencode\.local|OPENCODE_' || true)
if [ -z "$BRANDING_LEAKS" ]; then
  echo "  PASS: --help has no upstream branding leaks"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: --help contains upstream branding:"
  echo "$BRANDING_LEAKS" | head -5 | sed 's/^/    /'
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# 12. No "opencode" in welcome/hint strings visible at startup
# Check the binary's embedded strings for user-facing "opencode" references
SUBCOMMAND_HELP=$(altimate run --help 2>&1 || echo "")
SUBCOMMAND_LEAKS=$(echo "$SUBCOMMAND_HELP" | grep -iE 'opencode' | grep -ivE '\.opencode|opencode\.json[c]?|@opencode-ai|opencode\.local|OPENCODE_' || true)
if [ -z "$SUBCOMMAND_LEAKS" ]; then
  echo "  PASS: 'altimate run --help' has no upstream branding leaks"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: 'altimate run --help' contains upstream branding:"
  echo "$SUBCOMMAND_LEAKS" | head -5 | sed 's/^/    /'
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# 13. Database driver packages resolvable (#295)
# All drivers use dynamic import() at runtime — if the package can't be resolved,
# the tool fails with "driver not installed". This catches the #295 regression
# where published binaries don't ship driver dependencies.
# NOTE: Drivers are not installed in the sanity Docker image (see Dockerfile
# comment). These checks emit warnings, not failures, until #295 is resolved.
echo "  --- Driver Resolvability ---"

DRIVERS=(
  "pg:pg"
  "snowflake-sdk:snowflake"
  "mysql2:mysql"
  "mssql:sqlserver"
  "duckdb:duckdb"
  "mongodb:mongodb"
  "@google-cloud/bigquery:bigquery"
  "@databricks/sql:databricks"
  "oracledb:oracle"
)

DRIVER_PASS=0
DRIVER_FAIL=0
DRIVER_NODE_PATH=$(npm root -g 2>/dev/null || echo "")
DRIVER_AC_NM="$DRIVER_NODE_PATH/altimate-code/node_modules"
for entry in "${DRIVERS[@]}"; do
  pkg="${entry%%:*}"
  label="${entry##*:}"
  if NODE_PATH="$DRIVER_NODE_PATH:$DRIVER_AC_NM" node -e "require.resolve('$pkg')" 2>/dev/null; then
    echo "  PASS: $label driver resolvable ($pkg)"
    DRIVER_PASS=$((DRIVER_PASS + 1))
  else
    echo "  WARN: $label driver not resolvable ($pkg) — see #295"
    DRIVER_FAIL=$((DRIVER_FAIL + 1))
  fi
done
echo "  Driver summary: $DRIVER_PASS resolvable, $DRIVER_FAIL missing"
# Count as a single pass/fail based on whether ANY driver is resolvable
if [ "$DRIVER_PASS" -gt 0 ]; then
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: no drivers resolvable at all"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

report_results "Phase 1: Verify Installation"
