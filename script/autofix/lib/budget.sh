#!/bin/bash
# lib/budget.sh — Monthly 50-fix budget cap with auto-reset

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# Initialize budget file if missing or new month
init_budget() {
  local current_month
  current_month="$(date -u +%Y-%m)"

  if [ ! -f "$BUDGET_FILE" ]; then
    echo "{\"month\":\"$current_month\",\"attempts\":0,\"successes\":0,\"failures\":0}" > "$BUDGET_FILE"
    return
  fi

  local stored_month
  stored_month="$(json_get "$BUDGET_FILE" '.month')"

  if [ "$stored_month" != "$current_month" ]; then
    log_info "Budget reset: $stored_month -> $current_month"
    echo "{\"month\":\"$current_month\",\"attempts\":0,\"successes\":0,\"failures\":0}" > "$BUDGET_FILE"
  fi
}

# Returns 0 if budget available, 1 if exhausted
check_budget() {
  init_budget
  local attempts
  attempts="$(json_get "$BUDGET_FILE" '.attempts')"
  if [ "$attempts" -ge "$MAX_MONTHLY_ATTEMPTS" ]; then
    log_warn "Budget exhausted: $attempts/$MAX_MONTHLY_ATTEMPTS attempts this month"
    return 1
  fi
  return 0
}

# Increment budget counter: increment_budget <success|failure>
increment_budget() {
  local result="$1"
  init_budget

  local tmp
  tmp="$(mktemp)"

  if [ "$result" = "success" ]; then
    jq '.attempts += 1 | .successes += 1' "$BUDGET_FILE" > "$tmp"
  else
    jq '.attempts += 1 | .failures += 1' "$BUDGET_FILE" > "$tmp"
  fi

  mv "$tmp" "$BUDGET_FILE"
}

# Print current budget status
get_budget_status() {
  init_budget
  local attempts successes failures
  attempts="$(json_get "$BUDGET_FILE" '.attempts')"
  successes="$(json_get "$BUDGET_FILE" '.successes')"
  failures="$(json_get "$BUDGET_FILE" '.failures')"
  echo "$attempts/$MAX_MONTHLY_ATTEMPTS attempts ($successes success, $failures failed)"
}
