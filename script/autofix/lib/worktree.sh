#!/bin/bash
# lib/worktree.sh — Git worktree management for parallel fixes

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# Create a worktree for an issue: create_worktree <issue_number>
# Sets WORKTREE_PATH to the created path
create_worktree() {
  local issue_number="$1"
  local branch="autofix/issue-${issue_number}"
  WORKTREE_PATH="${WORKTREE_BASE}/issue-${issue_number}"

  mkdir -p "$WORKTREE_BASE"

  # Clean up if stale worktree exists
  if [ -d "$WORKTREE_PATH" ]; then
    log_warn "Stale worktree exists for issue #$issue_number, removing"
    cd "$REPO_DIR"
    git worktree remove --force "$WORKTREE_PATH" 2>/dev/null || true
  fi

  # Delete existing branch if it exists (stale from previous failed attempt)
  cd "$REPO_DIR"
  git branch -D "$branch" 2>/dev/null || true

  # Create worktree from latest main
  git worktree add "$WORKTREE_PATH" -b "$branch" origin/main
  log_info "Created worktree at $WORKTREE_PATH (branch: $branch)"
}

# Remove a worktree: remove_worktree <issue_number>
remove_worktree() {
  local issue_number="$1"
  local path="${WORKTREE_BASE}/issue-${issue_number}"

  if [ -d "$path" ]; then
    cd "$REPO_DIR"
    git worktree remove --force "$path" 2>/dev/null || true
    log_info "Removed worktree for issue #$issue_number"
  fi
}

# Clean up stale worktrees older than 24h
cleanup_stale_worktrees() {
  if [ ! -d "$WORKTREE_BASE" ]; then
    return
  fi

  find "$WORKTREE_BASE" -maxdepth 1 -type d -mmin +1440 | while read -r dir; do
    if [ "$dir" = "$WORKTREE_BASE" ]; then
      continue
    fi
    log_warn "Cleaning stale worktree: $dir"
    cd "$REPO_DIR"
    git worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
  done
}
