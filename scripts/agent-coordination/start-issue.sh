#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/lib/agent_issue_workflow.sh"
agent_require_tools

AGENT_ISSUE_NUMBER=
AGENT_TTL_SECONDS=${DEFAULT_TTL_SECONDS}
agent_label_override=
branch_override=
notes='Starting work'
base_ref='origin/main'
checkout_path=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue|--issue-number)
      AGENT_ISSUE_NUMBER=${2:-}; shift 2 ;;
    --agent-label)
      agent_label_override=${2:-}; shift 2 ;;
    --ttl-seconds)
      AGENT_TTL_SECONDS=${2:-}; shift 2 ;;
    --branch)
      branch_override=${2:-}; shift 2 ;;
    --base-ref)
      base_ref=${2:-}; shift 2 ;;
    --checkout-path|--worktree-path)
      checkout_path=${2:-}; shift 2 ;;
    --notes)
      notes=${2:-}; shift 2 ;;
    --*)
      agent_fail "Unknown option: $1" 2 '{}' ;;
    *)
      if [[ -z "$AGENT_ISSUE_NUMBER" ]]; then AGENT_ISSUE_NUMBER=$1; shift; else agent_fail "Unexpected argument: $1" 2 '{}'; fi ;;
  esac
done
export AGENT_ISSUE_NUMBER AGENT_TTL_SECONDS

repo=$(agent_repo)
issue_number=$(agent_issue_number)
issue=$(agent_fetch_issue "$repo" "$issue_number")
title=$(jq -r '.title // "issue"' <<<"$issue")
branch=${branch_override:-$(agent_branch_name "$issue_number" "$title")}
agent_validate_branch_name "$branch"

repo_root=$(git -C "$ROOT_DIR/.." rev-parse --show-toplevel)
git -C "$repo_root" fetch origin main --quiet

git -C "$repo_root" rev-parse --verify "$base_ref^{commit}" >/dev/null 2>&1 || agent_fail 'Base ref does not resolve to a commit.' 2 "$(jq -n --arg base_ref "$base_ref" '{base_ref:$base_ref}')"

if [[ -n "$checkout_path" ]]; then
  worktree_path=$checkout_path
else
  safe_branch=$(printf '%s' "$branch" | tr '/' '-')
  repo_slug=$(basename "$repo_root")
  worktree_path="/tmp/${repo_slug}-${safe_branch}"
fi

claim_json=$(OPENCLAW_AGENT_LABEL="${agent_label_override:-$(agent_identity_label)}" "$ROOT_DIR/gh-claim-issue" --issue "$issue_number" --agent-label "${agent_label_override:-$(agent_identity_label)}" --branch "$branch" --ttl-seconds "$AGENT_TTL_SECONDS" --notes "$notes")
run_id=$(jq -r '.run_id' <<<"$claim_json")
claimed_at=$(jq -r '.claimed_at' <<<"$claim_json")
lease_expires_at=$(jq -r '.lease_expires_at' <<<"$claim_json")

if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
  existing_branch=1
else
  existing_branch=0
fi

if [[ -e "$worktree_path" ]]; then
  agent_fail 'Requested checkout path already exists.' 2 "$(jq -n --arg worktree_path "$worktree_path" '{worktree_path:$worktree_path}')"
fi

if [[ "$existing_branch" -eq 1 ]]; then
  git -C "$repo_root" worktree add "$worktree_path" "$branch" >/dev/null
else
  git -C "$repo_root" worktree add "$worktree_path" -b "$branch" "$base_ref" >/dev/null
fi

checklist=$(jq -n '[
  "Read the full issue thread, including every comment, before planning or coding.",
  "Synthesize the issue truth: original ask, latest authoritative guidance, acceptance criteria, blockers, and reopen context.",
  "Open a draft PR early with Refs #<issue> until ready to close.",
  "Refresh the claim with heartbeat-claim.sh while work is active.",
  "If you create a watcher/follow-up, prefer a one-shot job; otherwise set an explicit expiry and remove it on merge, blocked release, completed release, or handoff."
]')

jq -n \
  --argjson issue "$issue_number" \
  --arg run_id "$run_id" \
  --arg branch "$branch" \
  --arg base_ref "$base_ref" \
  --arg worktree_path "$worktree_path" \
  --arg claimed_at "$claimed_at" \
  --arg lease_expires_at "$lease_expires_at" \
  --argjson checklist "$checklist" \
  '{ok:true,issue:$issue,run_id:$run_id,branch:$branch,base_ref:$base_ref,worktree_path:$worktree_path,claimed_at:$claimed_at,lease_expires_at:$lease_expires_at,next_steps:$checklist}'
