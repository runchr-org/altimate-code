#!/bin/bash
# lib/telemetry.sh — Azure App Insights query wrapper

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# Run a KQL query against Log Analytics: la_query <kql_string>
# Outputs JSON result to stdout
la_query() {
  local query="$1"
  api_retry az monitor log-analytics query \
    --workspace "$LA_WORKSPACE_ID" \
    --analytics-query "$query" \
    --output json 2>/dev/null
}

# Normalize error string for dedup key
normalize_error() {
  local err="$1"
  echo "$err" \
    | sed -E 's|/[^ ]*\.[a-z]+|<path>|g' \
    | sed -E 's|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|<uuid>|g' \
    | sed -E 's|[0-9]{7,}|<num>|g' \
    | tr '[:upper:]' '[:lower:]' \
    | tr -s ' ' \
    | head -c 80
}

# Check if a dedup key already exists in seen-issues.json
is_known_issue() {
  local key="$1"
  jq -e --arg k "$key" 'has($k)' "$TELEMETRY_FILE" > /dev/null 2>&1
}

# Add/update entry in seen-issues.json
update_seen_issue() {
  local key="$1"
  local count="$2"
  local jira_ticket="${3:-null}"

  local tmp
  tmp="$(mktemp)"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if is_known_issue "$key"; then
    # Update existing
    jq --arg k "$key" --arg count "$count" --arg now "$now" \
      '.[$k].last_count = ($count | tonumber) | .[$k].last_checked = $now' \
      "$TELEMETRY_FILE" > "$tmp"
  else
    # Add new
    local first_seen="$now"
    if [ "$jira_ticket" = "null" ]; then
      jq --arg k "$key" --arg count "$count" --arg now "$now" \
        '.[$k] = {jira_ticket: null, first_seen: $now, last_count: ($count | tonumber), last_checked: $now}' \
        "$TELEMETRY_FILE" > "$tmp"
    else
      jq --arg k "$key" --arg count "$count" --arg now "$now" --arg ticket "$jira_ticket" \
        '.[$k] = {jira_ticket: $ticket, first_seen: $now, last_count: ($count | tonumber), last_checked: $now}' \
        "$TELEMETRY_FILE" > "$tmp"
    fi
  fi

  mv "$tmp" "$TELEMETRY_FILE"
}

# Classify if an error pattern is auto-fixable
# Returns: "fixable", "maybe", or "human"
classify_fixability() {
  local key="$1"
  local err_text="$2"

  case "$err_text" in
    *"driver not installed"*)  echo "fixable" ;;
    *"not a function"*)        echo "fixable" ;;
    *"undefined"*)             echo "fixable" ;;
    *"cannot read prop"*)      echo "fixable" ;;
    *"is not defined"*)        echo "fixable" ;;
    *"module not found"*)      echo "fixable" ;;
    *"import"*"not found"*)    echo "fixable" ;;
    *)                         echo "human" ;;
  esac
}
