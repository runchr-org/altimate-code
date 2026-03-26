#!/bin/bash
# daemon.sh — Main autofix daemon. Polls for 'autofix' labeled issues every 5 min.
# Runs as systemd service on the Azure VM.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"
source "$SCRIPT_DIR/lib/budget.sh"
source "$SCRIPT_DIR/lib/worktree.sh"

log_info "=== Autofix daemon starting ==="
log_info "Repo: $REPO_DIR | Poll: ${POLL_INTERVAL}s | Max parallel: $MAX_PARALLEL"
log_info "Budget: $(get_budget_status)"

while true; do
  # Update repo
  cd "$REPO_DIR"
  git fetch origin main --quiet 2>/dev/null || true
  git checkout main --quiet 2>/dev/null || true
  git pull --ff-only --quiet 2>/dev/null || true

  # Clean stale worktrees
  cleanup_stale_worktrees

  # Check budget before polling
  if ! check_budget; then
    log_warn "Budget exhausted — sleeping until next month"
    sleep "$POLL_INTERVAL"
    continue
  fi

  # Fetch autofix-labeled issues
  ISSUES=$(gh issue list \
    --repo "$GH_REPO" \
    --label "$GH_LABEL_AUTOFIX" \
    --state open \
    --json number,title \
    --limit "$MAX_PARALLEL" 2>/dev/null || echo "[]")

  ISSUE_COUNT=$(echo "$ISSUES" | jq 'length')

  if [ "$ISSUE_COUNT" -gt 0 ]; then
    log_info "Found $ISSUE_COUNT autofix issue(s)"

    echo "$ISSUES" | jq -c '.[]' | while read -r issue; do
      NUMBER=$(echo "$issue" | jq -r '.number')
      TITLE=$(echo "$issue" | jq -r '.title')

      # Check budget before each spawn (mid-cycle check)
      if ! check_budget; then
        log_warn "Budget exhausted mid-cycle — stopping"
        break
      fi

      # Check parallel limit
      RUNNING=$(jobs -r 2>/dev/null | wc -l)
      if [ "$RUNNING" -ge "$MAX_PARALLEL" ]; then
        log_info "Max parallel ($MAX_PARALLEL) reached — waiting for a slot"
        wait -n 2>/dev/null || true
      fi

      log_info "Dispatching fix for #$NUMBER: $TITLE"
      bash "$SCRIPT_DIR/fix-issue.sh" "$NUMBER" &
    done

    # Wait for all background jobs to finish
    wait
  fi

  sleep "$POLL_INTERVAL"
done
