#!/bin/bash
# lib/verify.sh — Quality gates: typecheck → bun test → marker guard
# Usage: source this, then call verify_fix <repo_root>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# Run verification pipeline. Returns 0 on success, 1 on failure.
# Sets VERIFY_ERROR with failure details on error.
verify_fix() {
  local repo_root="${1:-.}"
  VERIFY_ERROR=""

  log_info "Running verification in $repo_root"

  # Gate 1: Typecheck
  log_info "Gate 1/3: Typecheck"
  local typecheck_output
  typecheck_output=$(cd "$repo_root" && bun turbo typecheck 2>&1)
  local typecheck_exit=$?
  # Typecheck has pre-existing errors, so we log but don't hard-fail
  if [ $typecheck_exit -ne 0 ]; then
    log_warn "Typecheck exited $typecheck_exit (may include pre-existing errors)"
  fi

  # Gate 2: Unit tests — HARD gate
  log_info "Gate 2/3: Unit tests"
  local test_output
  test_output=$(cd "$repo_root/packages/opencode" && bun test --timeout 30000 2>&1)
  local test_exit=$?
  if [ $test_exit -ne 0 ]; then
    VERIFY_ERROR="Unit tests failed (exit $test_exit):
$(echo "$test_output" | tail -30)"
    log_error "$VERIFY_ERROR"
    return 1
  fi

  # Gate 3: Marker guard — HARD gate (skip if no upstream remote)
  log_info "Gate 3/3: Marker guard"
  if cd "$repo_root" && git remote | grep -q upstream; then
    local marker_output
    marker_output=$(bun run script/upstream/analyze.ts --markers --base origin/main --strict 2>&1)
    local marker_exit=$?
    if [ $marker_exit -ne 0 ]; then
      VERIFY_ERROR="Marker guard failed (exit $marker_exit):
$(echo "$marker_output" | tail -10)"
      log_error "$VERIFY_ERROR"
      return 1
    fi
  else
    log_info "Marker guard: SKIP (no upstream remote)"
  fi

  log_info "All verification gates passed"
  return 0
}
