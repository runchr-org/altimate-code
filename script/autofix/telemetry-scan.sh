#!/bin/bash
# telemetry-scan.sh — Loop A: Query App Insights every 2h, create issues for new patterns
# Run via cron: 0 */2 * * *
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"
source "$SCRIPT_DIR/lib/telemetry.sh"

log_info "=== Telemetry scan starting ==="

# ── Q1: Core failures ────────────────────────────────────────

log_info "Querying core failures..."
Q1_RESULT=$(la_query "
AppEvents | where TimeGenerated > ago(2h) and Name == 'core_failure'
| extend err = tostring(Properties.error_message),
         tool = tostring(Properties.tool_name),
         err_class = tostring(Properties.error_class)
| summarize count() by err, tool, err_class
| where count_ > $TELEMETRY_THRESHOLD
| order by count_ desc
")

if [ -n "$Q1_RESULT" ] && [ "$Q1_RESULT" != "[]" ]; then
  echo "$Q1_RESULT" | jq -c '.[]' 2>/dev/null | while read -r row; do
    tool=$(echo "$row" | jq -r '.tool // "unknown"')
    err=$(echo "$row" | jq -r '.err // "unknown"')
    count=$(echo "$row" | jq -r '.count_')
    norm_err=$(normalize_error "$err")
    key="core_failure::${tool}::${norm_err}"

    if ! is_known_issue "$key"; then
      log_info "New pattern: $key (count: $count)"
      update_seen_issue "$key" "$count"

      fixability=$(classify_fixability "$key" "$err")
      if [ "$fixability" = "fixable" ]; then
        log_info "Creating autofix issue for $key"
        api_retry gh issue create \
          --repo "$GH_REPO" \
          --title "[autofix] $key" \
          --body "**Telemetry pattern detected** (count: $count in last 2h)

Error: \`$err\`
Tool: \`$tool\`

This pattern was automatically classified as fixable by the telemetry scan." \
          --label "$GH_LABEL_AUTOFIX" \
          --label "telemetry" 2>/dev/null || true
      fi
    else
      update_seen_issue "$key" "$count"
    fi
  done
fi

# ── Q2: SQL failures ─────────────────────────────────────────

log_info "Querying SQL failures..."
Q2_RESULT=$(la_query "
AppEvents | where TimeGenerated > ago(2h) and Name == 'sql_execute_failure'
| extend warehouse = tostring(Properties.warehouse_type),
         err = tostring(Properties.error_message)
| summarize count() by warehouse, err
| where count_ > $TELEMETRY_THRESHOLD
| order by count_ desc
")

if [ -n "$Q2_RESULT" ] && [ "$Q2_RESULT" != "[]" ]; then
  echo "$Q2_RESULT" | jq -c '.[]' 2>/dev/null | while read -r row; do
    warehouse=$(echo "$row" | jq -r '.warehouse // "unknown"')
    err=$(echo "$row" | jq -r '.err // "unknown"')
    count=$(echo "$row" | jq -r '.count_')
    norm_err=$(normalize_error "$err")
    key="sql_failure::${warehouse}::${norm_err}"

    if ! is_known_issue "$key"; then
      log_info "New SQL pattern: $key (count: $count)"
      update_seen_issue "$key" "$count"

      fixability=$(classify_fixability "$key" "$err")
      if [ "$fixability" = "fixable" ]; then
        api_retry gh issue create \
          --repo "$GH_REPO" \
          --title "[autofix] $key" \
          --body "**SQL failure pattern** (count: $count in last 2h)

Warehouse: \`$warehouse\`
Error: \`$err\`" \
          --label "$GH_LABEL_AUTOFIX" \
          --label "telemetry" 2>/dev/null || true
      fi
    else
      update_seen_issue "$key" "$count"
    fi
  done
fi

# ── Q3: Provider errors ──────────────────────────────────────

log_info "Querying provider errors..."
Q3_RESULT=$(la_query "
AppEvents | where TimeGenerated > ago(2h) and Name == 'provider_error'
| extend provider = tostring(Properties.provider_id),
         model = tostring(Properties.model_id),
         err_type = tostring(Properties.error_type)
| summarize count() by provider, model, err_type
| where count_ > $TELEMETRY_THRESHOLD
| order by count_ desc
")

if [ -n "$Q3_RESULT" ] && [ "$Q3_RESULT" != "[]" ]; then
  echo "$Q3_RESULT" | jq -c '.[]' 2>/dev/null | while read -r row; do
    provider=$(echo "$row" | jq -r '.provider // "unknown"')
    err_type=$(echo "$row" | jq -r '.err_type // "unknown"')
    count=$(echo "$row" | jq -r '.count_')
    key="provider_error::${provider}::${err_type}"

    if ! is_known_issue "$key"; then
      log_info "New provider error: $key (count: $count)"
      update_seen_issue "$key" "$count"
      # Provider errors are typically not auto-fixable (external service issues)
    else
      update_seen_issue "$key" "$count"
    fi
  done
fi

# ── Q4: Application errors ───────────────────────────────────

log_info "Querying application errors..."
Q4_RESULT=$(la_query "
AppEvents | where TimeGenerated > ago(2h) and Name == 'error'
| extend err_name = tostring(Properties.error_name),
         context = tostring(Properties.context)
| summarize count() by err_name, context
| where count_ > $TELEMETRY_THRESHOLD
| order by count_ desc
")

if [ -n "$Q4_RESULT" ] && [ "$Q4_RESULT" != "[]" ]; then
  echo "$Q4_RESULT" | jq -c '.[]' 2>/dev/null | while read -r row; do
    err_name=$(echo "$row" | jq -r '.err_name // "unknown"')
    context=$(echo "$row" | jq -r '.context // "unknown"')
    count=$(echo "$row" | jq -r '.count_')
    norm_name=$(normalize_error "$err_name")
    key="error::${norm_name}::${context}"

    if ! is_known_issue "$key"; then
      log_info "New error pattern: $key (count: $count)"
      update_seen_issue "$key" "$count"

      fixability=$(classify_fixability "$key" "$err_name")
      if [ "$fixability" = "fixable" ]; then
        api_retry gh issue create \
          --repo "$GH_REPO" \
          --title "[autofix] $key" \
          --body "**Application error** (count: $count in last 2h)

Error: \`$err_name\`
Context: \`$context\`" \
          --label "$GH_LABEL_AUTOFIX" \
          --label "telemetry" 2>/dev/null || true
      fi
    else
      update_seen_issue "$key" "$count"
    fi
  done
fi

# Commit updated seen-issues.json if changed
cd "$REPO_DIR"
if ! git diff --quiet "$TELEMETRY_FILE" 2>/dev/null; then
  git add "$TELEMETRY_FILE"
  git commit -m "chore: update telemetry seen-issues.json [autofix]" --quiet 2>/dev/null || true
  git push origin main --quiet 2>/dev/null || true
fi

log_info "=== Telemetry scan complete ==="
