#!/bin/bash
# lib/slack.sh — Slack posting via slack-tools

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# Post a message to the configured Slack channel
# Usage: slack_post <message_text>
slack_post() {
  local text="$1"

  if [ -z "$SLACK_CHANNEL_ID" ]; then
    log_error "SLACK_CHANNEL_ID not set — cannot post to Slack"
    return 1
  fi

  if [ ! -d "$SLACK_TOOLS_DIR" ]; then
    log_error "Slack tools directory not found: $SLACK_TOOLS_DIR"
    return 1
  fi

  cd "$SLACK_TOOLS_DIR"
  api_retry .venv/bin/python send_reply.py \
    --channel "$SLACK_CHANNEL_ID" \
    --text "$text" 2>/dev/null

  if [ $? -eq 0 ]; then
    log_info "Slack message posted to channel $SLACK_CHANNEL_ID"
  else
    log_error "Failed to post Slack message"
    return 1
  fi
}
