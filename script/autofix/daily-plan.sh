#!/bin/bash
# daily-plan.sh — Loop B: Post daily improvement plan to Slack at 9 AM PST (17:00 UTC)
# Run via cron: 0 17 * * *
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"
source "$SCRIPT_DIR/lib/budget.sh"
source "$SCRIPT_DIR/lib/slack.sh"

log_info "=== Daily plan generation starting ==="

DATE=$(date -u +%Y-%m-%d)

# ── Gather data ──────────────────────────────────────────────

# Budget status
BUDGET_STATUS=$(get_budget_status)

# Top telemetry patterns by count
TOP_ERRORS=""
if [ -f "$TELEMETRY_FILE" ]; then
  TOP_ERRORS=$(jq -r '
    to_entries
    | sort_by(-.value.last_count)
    | .[0:5]
    | .[]
    | "\(.value.last_count) | \(.key) | \(.value.jira_ticket // "no ticket")"
  ' "$TELEMETRY_FILE" 2>/dev/null || echo "")
fi

# Open autofix PRs
OPEN_PRS=$(gh pr list \
  --repo "$GH_REPO" \
  --label "$GH_LABEL_AUTOFIX" \
  --state open \
  --json number,title,url \
  --limit 10 2>/dev/null || echo "[]")
PR_COUNT=$(echo "$OPEN_PRS" | jq 'length')

# Recently merged autofix PRs (last 24h)
MERGED_PRS=$(gh pr list \
  --repo "$GH_REPO" \
  --label "$GH_LABEL_AUTOFIX" \
  --state merged \
  --json number,title,mergedAt \
  --limit 5 2>/dev/null || echo "[]")
MERGED_TODAY=$(echo "$MERGED_PRS" | jq "[.[] | select(.mergedAt > \"$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)\")] | length")

# Failed autofix issues
FAILED_ISSUES=$(gh issue list \
  --repo "$GH_REPO" \
  --label "$GH_LABEL_FAILED" \
  --state open \
  --json number,title \
  --limit 5 2>/dev/null || echo "[]")
FAILED_COUNT=$(echo "$FAILED_ISSUES" | jq 'length')

# ── Build message ────────────────────────────────────────────

MSG="*Daily Improvement Plan -- ${DATE}*

*Top Error Patterns:*"

if [ -n "$TOP_ERRORS" ]; then
  RANK=1
  while IFS='|' read -r count key ticket; do
    count=$(echo "$count" | xargs)
    key=$(echo "$key" | xargs)
    ticket=$(echo "$ticket" | xargs)
    if [ "$ticket" != "no ticket" ] && [ "$ticket" != "null" ]; then
      MSG="${MSG}
${RANK}. \`${key}\` (${count} occurrences) -- ${ticket}"
    else
      MSG="${MSG}
${RANK}. \`${key}\` (${count} occurrences)"
    fi
    RANK=$((RANK + 1))
  done <<< "$TOP_ERRORS"
else
  MSG="${MSG}
No error patterns detected."
fi

MSG="${MSG}

*Autofix Status:*
- Budget: ${BUDGET_STATUS}
- Open PRs: ${PR_COUNT} pending review
- Merged today: ${MERGED_TODAY}
- Failed (needs human): ${FAILED_COUNT}"

# List open PRs
if [ "$PR_COUNT" -gt 0 ]; then
  MSG="${MSG}

*Pending Review:*"
  echo "$OPEN_PRS" | jq -c '.[]' | while read -r pr; do
    num=$(echo "$pr" | jq -r '.number')
    title=$(echo "$pr" | jq -r '.title')
    url=$(echo "$pr" | jq -r '.url')
    MSG="${MSG}
- #${num}: ${title} (${url})"
  done
fi

# List failed issues
if [ "$FAILED_COUNT" -gt 0 ]; then
  MSG="${MSG}

*Needs Human Investigation:*"
  echo "$FAILED_ISSUES" | jq -c '.[]' | while read -r issue; do
    num=$(echo "$issue" | jq -r '.number')
    title=$(echo "$issue" | jq -r '.title')
    MSG="${MSG}
- #${num}: ${title}"
  done
fi

# ── Post to Slack ────────────────────────────────────────────

log_info "Posting daily plan to Slack"
slack_post "$MSG"

log_info "=== Daily plan posted ==="
