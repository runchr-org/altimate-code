#!/bin/bash
# config.sh — All tunable constants for the autofix system
# Override any value via environment variables.

# Azure VM paths (on the VM)
export REPO_DIR="${REPO_DIR:-/home/kulvir/altimate-code}"
export LOG_DIR="${LOG_DIR:-/home/kulvir/autofix-logs}"
export WORKTREE_BASE="${WORKTREE_BASE:-/tmp/ac-autofix-worktrees}"

# GitHub
export GH_REPO="${GH_REPO:-AltimateAI/altimate-code}"
export GH_LABEL_AUTOFIX="${GH_LABEL_AUTOFIX:-autofix}"
export GH_LABEL_IN_PROGRESS="${GH_LABEL_IN_PROGRESS:-autofix-in-progress}"
export GH_LABEL_FAILED="${GH_LABEL_FAILED:-autofix-failed}"
export GH_LABEL_COMPLETED="${GH_LABEL_COMPLETED:-autofix-completed}"

# Codex CLI
export CODEX_MODEL="${CODEX_MODEL:-gpt-5.4}"
export CODEX_TIMEOUT="${CODEX_TIMEOUT:-1800}"  # 30 minutes

# Daemon
export POLL_INTERVAL="${POLL_INTERVAL:-300}"    # 5 minutes
export MAX_PARALLEL="${MAX_PARALLEL:-5}"

# Budget
export MAX_MONTHLY_ATTEMPTS="${MAX_MONTHLY_ATTEMPTS:-50}"
export BUDGET_FILE="${BUDGET_FILE:-$REPO_DIR/data/autofix/budget-state.json}"
export AUDIT_LOG="${AUDIT_LOG:-$REPO_DIR/data/autofix/audit-log.jsonl}"

# Telemetry (Azure App Insights)
export LA_WORKSPACE_ID="${LA_WORKSPACE_ID:-b511e30e-4b93-4093-98a5-b80fc4718111}"
export TELEMETRY_FILE="${TELEMETRY_FILE:-$REPO_DIR/data/telemetry/seen-issues.json}"
export TELEMETRY_THRESHOLD="${TELEMETRY_THRESHOLD:-10}"  # Min occurrences before creating issue

# Jira
export JIRA_CLOUD_ID="${JIRA_CLOUD_ID:-ae6de7ce-ca58-46e8-b583-1468bf597470}"
export JIRA_PROJECT="${JIRA_PROJECT:-AI}"

# Slack
export SLACK_TOOLS_DIR="${SLACK_TOOLS_DIR:-/home/kulvir/slack-tools}"
export SLACK_CHANNEL_ID="${SLACK_CHANNEL_ID:-}"  # Set during bootstrap

# Retry
export MAX_RETRIES="${MAX_RETRIES:-5}"
export RETRY_BASE_DELAY="${RETRY_BASE_DELAY:-2}"  # seconds, doubles each retry
