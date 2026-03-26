#!/bin/bash
# lib/common.sh — Logging, JSON utils, exponential backoff retry

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/config.sh"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# ── Logging ──────────────────────────────────────────────────

log() {
  local level="$1"; shift
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [$level] $*" | tee -a "$LOG_DIR/daemon.log"
}

log_info()  { log "INFO"  "$@"; }
log_warn()  { log "WARN"  "$@"; }
log_error() { log "ERROR" "$@"; }

# ── Exponential backoff retry ────────────────────────────────

# Usage: api_retry <command> [args...]
# Retries up to MAX_RETRIES times with exponential backoff (2s, 4s, 8s, 16s, 32s)
api_retry() {
  local attempt=0
  local delay="$RETRY_BASE_DELAY"

  while [ "$attempt" -lt "$MAX_RETRIES" ]; do
    if "$@"; then
      return 0
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -lt "$MAX_RETRIES" ]; then
      log_warn "Retry $attempt/$MAX_RETRIES in ${delay}s: $*"
      sleep "$delay"
      delay=$((delay * 2))
    fi
  done

  log_error "Failed after $MAX_RETRIES attempts: $*"
  return 1
}

# ── JSON helpers ─────────────────────────────────────────────

# Read a JSON field: json_get <file> <jq_expr>
json_get() {
  jq -r "$2" < "$1" 2>/dev/null
}

# Write audit log entry (append JSONL)
audit_log() {
  local issue_number="$1"
  local status="$2"  # success | failure
  local details="$3"

  local entry
  entry=$(jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg issue "$issue_number" \
    --arg status "$status" \
    --arg details "$details" \
    '{timestamp: $ts, issue: $issue, status: $status, details: $details}')

  echo "$entry" >> "$AUDIT_LOG"
}
