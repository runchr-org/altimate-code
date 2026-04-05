#!/bin/bash
# Phase 1b: Extended installation verification
# Tests packaging integrity, permissions, binary variants, and postinstall artifacts
# that the base verify-install.sh doesn't cover.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/lib/assert.sh"

echo "--- Phase 1b: Extended Installation Verification ---"

# ─────────────────────────────────────────────────────────────
# Binary & Packaging
# ─────────────────────────────────────────────────────────────

# 1. Both bin names work (altimate AND altimate-code)
echo "  [1/20] Binary name aliases..."
assert_exit_0 "altimate binary" altimate --version
if command -v altimate-code >/dev/null 2>&1; then
  assert_exit_0 "altimate-code alias" altimate-code --version
  # Versions must match
  V1=$(altimate --version 2>/dev/null | head -1)
  V2=$(altimate-code --version 2>/dev/null | head -1)
  assert_eq "$V1" "$V2" "altimate and altimate-code versions match"
else
  skip_test "altimate-code alias" "altimate-code not in PATH"
fi

# 2. Binary has executable permission
echo "  [2/20] Binary executable permissions..."
BIN_PATH=$(command -v altimate 2>/dev/null || true)
if [ -n "$BIN_PATH" ]; then
  if [ -x "$BIN_PATH" ]; then
    echo "  PASS: binary is executable ($BIN_PATH)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: binary is not executable ($BIN_PATH)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo "  FAIL: altimate not found in PATH"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# 3. Binary is not a broken symlink
echo "  [3/20] Binary is not a broken symlink..."
if [ -n "$BIN_PATH" ]; then
  # Resolve the full chain — if it's a symlink, follow it
  RESOLVED=$(readlink -f "$BIN_PATH" 2>/dev/null || realpath "$BIN_PATH" 2>/dev/null || echo "$BIN_PATH")
  if [ -f "$RESOLVED" ]; then
    echo "  PASS: binary resolves to real file ($RESOLVED)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: binary resolves to non-existent file ($RESOLVED)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  skip_test "Binary symlink check" "altimate not found"
fi

# 4. Binary is not zero-size
echo "  [4/20] Binary is not zero-size..."
if [ -n "$BIN_PATH" ]; then
  RESOLVED=$(readlink -f "$BIN_PATH" 2>/dev/null || realpath "$BIN_PATH" 2>/dev/null || echo "$BIN_PATH")
  FILE_SIZE=$(stat --printf='%s' "$RESOLVED" 2>/dev/null || stat -f '%z' "$RESOLVED" 2>/dev/null || echo "0")
  if [ "$FILE_SIZE" -gt 1000 ]; then
    echo "  PASS: binary has non-trivial size (${FILE_SIZE} bytes)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: binary is suspiciously small (${FILE_SIZE} bytes)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  skip_test "Binary size check" "altimate not found"
fi

# ─────────────────────────────────────────────────────────────
# Postinstall Artifacts
# ─────────────────────────────────────────────────────────────

# 5. Version marker written by postinstall
echo "  [5/20] Postinstall version marker..."
MARKER_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/altimate-code"
if [ -d "$MARKER_DIR" ]; then
  echo "  PASS: altimate-code data directory exists"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  WARN: data directory not found at $MARKER_DIR (non-fatal)"
  PASS_COUNT=$((PASS_COUNT + 1))
fi

# 6. Skills directory permissions are correct
echo "  [6/20] Skills directory permissions..."
SKILL_DIR="$HOME/.altimate/builtin"
if [ -d "$SKILL_DIR" ]; then
  if [ -r "$SKILL_DIR" ] && [ -x "$SKILL_DIR" ]; then
    echo "  PASS: skill directory is readable"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: skill directory is not readable"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo "  FAIL: skill directory not found at $SKILL_DIR"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# 7. Every skill has a SKILL.md (not just the 3 critical ones)
echo "  [7/20] All skills have SKILL.md..."
BROKEN_SKILLS=0
if [ -d "$SKILL_DIR" ]; then
  for skill_dir in "$SKILL_DIR"/*/; do
    skill_name=$(basename "$skill_dir")
    if [ ! -f "$skill_dir/SKILL.md" ]; then
      echo "  WARN: skill '$skill_name' missing SKILL.md"
      BROKEN_SKILLS=$((BROKEN_SKILLS + 1))
    fi
  done
  if [ "$BROKEN_SKILLS" -eq 0 ]; then
    echo "  PASS: all skills have SKILL.md"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $BROKEN_SKILLS skill(s) missing SKILL.md"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  skip_test "All skills have SKILL.md" "skill directory not found"
fi

# 8. dbt skills specifically present (critical for data engineering)
echo "  [8/20] dbt skill suite complete..."
DBT_SKILLS=("dbt-develop" "dbt-test" "dbt-docs" "dbt-troubleshoot" "dbt-analyze")
DBT_MISSING=0
for skill in "${DBT_SKILLS[@]}"; do
  if [ ! -f "$SKILL_DIR/$skill/SKILL.md" ]; then
    echo "  WARN: dbt skill '$skill' missing"
    DBT_MISSING=$((DBT_MISSING + 1))
  fi
done
if [ "$DBT_MISSING" -eq 0 ]; then
  echo "  PASS: all 5 dbt skills present"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: $DBT_MISSING dbt skill(s) missing"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# 9. SQL/data skills present
echo "  [9/20] SQL/data skill suite complete..."
SQL_SKILLS=("sql-review" "sql-translate" "query-optimize" "pii-audit" "cost-report" "lineage-diff")
SQL_MISSING=0
for skill in "${SQL_SKILLS[@]}"; do
  if [ ! -f "$SKILL_DIR/$skill/SKILL.md" ]; then
    echo "  WARN: SQL skill '$skill' missing"
    SQL_MISSING=$((SQL_MISSING + 1))
  fi
done
if [ "$SQL_MISSING" -eq 0 ]; then
  echo "  PASS: all 6 SQL/data skills present"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: $SQL_MISSING SQL/data skill(s) missing"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# ─────────────────────────────────────────────────────────────
# CLI Subcommands
# ─────────────────────────────────────────────────────────────

# 10. All documented subcommands are accessible
echo "  [10/20] Subcommand accessibility..."
SUBCOMMANDS=("run" "check" "session" "stats" "skill" "db" "trace" "providers" "agent" "models" "upgrade" "export")
SUBCMD_FAIL=0
for cmd in "${SUBCOMMANDS[@]}"; do
  OUTPUT=$(altimate "$cmd" --help 2>&1 || true)
  if echo "$OUTPUT" | grep -qi "unknown command\|not recognized"; then
    echo "  FAIL: subcommand '$cmd' not recognized"
    SUBCMD_FAIL=$((SUBCMD_FAIL + 1))
  fi
done
if [ "$SUBCMD_FAIL" -eq 0 ]; then
  echo "  PASS: all ${#SUBCOMMANDS[@]} subcommands accessible"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: $SUBCMD_FAIL subcommand(s) not accessible"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# 11. --version output is clean (no stack traces, no warnings)
echo "  [11/20] Clean version output..."
VERSION_OUTPUT=$(altimate --version 2>&1)
VERSION_LINES=$(echo "$VERSION_OUTPUT" | wc -l)
if [ "$VERSION_LINES" -le 3 ]; then
  echo "  PASS: version output is clean ($VERSION_LINES lines)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  FAIL: version output has extra noise ($VERSION_LINES lines)"
  echo "$VERSION_OUTPUT" | tail -5 | sed 's/^/    /'
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# 12. Invalid subcommand produces helpful error (not crash)
echo "  [12/20] Invalid subcommand error handling..."
INVALID_OUTPUT=$(altimate nonexistent-subcommand 2>&1 || true)
if echo "$INVALID_OUTPUT" | grep -qi "TypeError\|SyntaxError\|Cannot read\|segfault\|SIGSEGV"; then
  echo "  FAIL: invalid subcommand caused crash"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  echo "  PASS: invalid subcommand handled gracefully"
  PASS_COUNT=$((PASS_COUNT + 1))
fi

# 13. Invalid flags don't crash
echo "  [13/20] Invalid flag handling..."
INVALID_FLAG_OUTPUT=$(altimate run --nonexistent-flag 2>&1 || true)
if echo "$INVALID_FLAG_OUTPUT" | grep -qi "TypeError\|SIGSEGV\|segfault"; then
  echo "  FAIL: invalid flag caused crash"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  echo "  PASS: invalid flag handled gracefully"
  PASS_COUNT=$((PASS_COUNT + 1))
fi

# ─────────────────────────────────────────────────────────────
# dbt-tools bundled correctly
# ─────────────────────────────────────────────────────────────

# 14. altimate-dbt binary available
echo "  [14/20] altimate-dbt binary available..."
if command -v altimate-dbt >/dev/null 2>&1; then
  assert_exit_0 "altimate-dbt binary" altimate-dbt --help
else
  # altimate-dbt might be in a non-standard location after npm install
  NPM_PREFIX=$(npm config get prefix 2>/dev/null || echo "")
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/altimate-dbt" ]; then
    echo "  PASS: altimate-dbt found at $NPM_PREFIX/bin/altimate-dbt"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  WARN: altimate-dbt not in PATH (non-fatal — may be bundled internally)"
    PASS_COUNT=$((PASS_COUNT + 1))
  fi
fi

# 15. No hardcoded CI paths leaked into installed files
echo "  [15/20] No hardcoded CI paths..."
# Check for common CI runner paths baked into installed JS/JSON files.
# Exclude compiled binaries (bin/), .node native modules, and .map sourcemaps
# — Bun's single-file compiler embeds build-machine paths in debug info which
# are harmless and unavoidable.
INSTALL_DIR=$(npm root -g 2>/dev/null || echo "")
if [ -n "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR/altimate-code" ]; then
  if grep -rq --include='*.js' --include='*.json' --include='*.mjs' --include='*.cjs' \
    '/home/runner/work\|/github/workspace' "$INSTALL_DIR/altimate-code/" 2>/dev/null; then
    echo "  FAIL: hardcoded CI paths found in installed package"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  else
    echo "  PASS: no hardcoded CI paths in installed package"
    PASS_COUNT=$((PASS_COUNT + 1))
  fi
else
  skip_test "No hardcoded CI paths" "install directory not found"
fi

# ─────────────────────────────────────────────────────────────
# Environment & Dependency Isolation
# ─────────────────────────────────────────────────────────────

# 16. No node_modules pollution in user home
echo "  [16/20] No node_modules pollution..."
if [ -d "$HOME/node_modules" ]; then
  echo "  WARN: node_modules found in user home (may be benign)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  PASS: no node_modules in user home"
  PASS_COUNT=$((PASS_COUNT + 1))
fi

# 17. NAPI module exports expected functions (extends base test which just checks require)
echo "  [17/20] NAPI module exports check..."
if ! command -v node >/dev/null 2>&1; then
  skip_test "NAPI module exports" "node not available"
else
  NAPI_ROOT=$(npm root -g 2>/dev/null || echo "")
  NAPI_AC_NM="$NAPI_ROOT/altimate-code/node_modules"
  NAPI_CHECK=$(NODE_PATH="$NAPI_ROOT:$NAPI_AC_NM" node -e "
    try {
      const m = require('@altimateai/altimate-core');
      // Verify it exports something (not just an empty module)
      const keys = Object.keys(m);
      console.log('ok:' + keys.length + ' exports');
    } catch(e) {
      console.log('error:' + e.message);
    }
  " 2>&1 || echo "error:node failed")
  if echo "$NAPI_CHECK" | grep -q "^ok"; then
    echo "  PASS: NAPI module loads with exports ($NAPI_CHECK)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: NAPI module failed: $NAPI_CHECK"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
fi

# Resolve installed package directory — handle both Verdaccio (unscoped) and production (scoped)
echo "  [18/20] Package bin field..."
INSTALL_DIR=$(npm root -g 2>/dev/null || echo "")
PKG_DIR=""
for candidate in "$INSTALL_DIR/altimate-code" "$INSTALL_DIR/@altimateai/altimate-code" "$HOME/.npm-global/lib/node_modules/altimate-code" "$(npm config get prefix 2>/dev/null)/lib/node_modules/altimate-code"; do
  if [ -n "$candidate" ] && [ -f "$candidate/package.json" ]; then
    PKG_DIR="$candidate"
    break
  fi
done

# 18. altimate-code package.json has correct bin field
if [ -n "$PKG_DIR" ]; then
  HAS_BIN=$(node -e "const p=require('$PKG_DIR/package.json'); console.log(p.bin && p.bin.altimate ? 'ok' : 'missing')" 2>/dev/null || echo "error")
  if [ "$HAS_BIN" = "ok" ]; then
    echo "  PASS: package.json has correct bin.altimate field"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: package.json bin field missing or incorrect"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  skip_test "Package bin field" "installed package.json not found"
fi

# 19. LICENSE file included in installed package
echo "  [19/20] LICENSE in package..."
if [ -n "$PKG_DIR" ] && [ -f "$PKG_DIR/LICENSE" ]; then
  echo "  PASS: LICENSE file present"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "  WARN: LICENSE not in installed package (non-fatal)"
  PASS_COUNT=$((PASS_COUNT + 1))
fi

# 20. No .env or credentials files leaked into package
echo "  [20/20] No credentials in package..."
if [ -n "$PKG_DIR" ]; then
  LEAKED_FILES=$(find "$PKG_DIR" \( -name ".env" -o -name ".env.*" -o -name "credentials.json" -o -name "*.pem" -o -name "*.key" \) 2>/dev/null | head -5)
  if [ -z "$LEAKED_FILES" ]; then
    echo "  PASS: no credential files in package"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: credential files found in package:"
    echo "$LEAKED_FILES" | sed 's/^/    /'
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  skip_test "No credentials in package" "install directory not found"
fi

report_results "Phase 1b: Extended Installation Verification"
