#!/usr/bin/env bash
# preflight-check.sh — Validate pi extension workflow metadata before opening or promoting a PR.
#
# Usage:
#   scripts/agent-coordination/preflight-check.sh [--issue <n>] [--branch <branch>] [--pr-body <file>] [--check-claim] [--autofix-ok]
#
# Run this script from the repo root or from an issue worktree before:
#   - Opening a new draft PR
#   - Promoting a PR with promote-pr.sh
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed (recovery hints printed to stdout)
#   2  Usage or configuration error
#   3  Required tool missing
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/lib/agent_issue_workflow.sh"
agent_require_tools

repo=$(agent_repo)
branch=
issue_number=
pr_body_file=
check_claim=false
autofix_ok=false
quiet=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)       branch=${2:-}; shift 2 ;;
    --issue)        issue_number=${2:-}; shift 2 ;;
    --pr-body)      pr_body_file=${2:-}; shift 2 ;;
    --check-claim)  check_claim=true; shift ;;
    --autofix-ok)   autofix_ok=true; shift ;;
    --quiet)        quiet=true; shift ;;
    --*)            agent_fail "Unknown option: $1" 2 '{}' ;;
    *)              agent_fail "Unexpected argument: $1" 2 '{}' ;;
  esac
done

# Resolve branch from git if not supplied
repo_root=$(git -C "$ROOT_DIR/.." rev-parse --show-toplevel)
if [[ -z "$branch" ]]; then
  branch=$(git -C "$repo_root" branch --show-current 2>/dev/null || true)
fi

errors=()
warnings=()

# ── 1. Branch naming ────────────────────────────────────────────────────────
BRANCH_PATTERN='^(fix|feature|issue)/(issue-)?[0-9]{1,6}(-[a-z0-9]+)+$'
if [[ -z "$branch" ]]; then
  errors+=("Could not determine branch name. Supply --branch or run from a checked-out issue branch.")
elif [[ ! "$branch" =~ $BRANCH_PATTERN ]]; then
  errors+=("Branch '${branch}' does not match the required pattern: fix/<issue>-slug, feature/<issue>-slug, or issue/<issue>-slug.")
fi

# ── 2. Derive issue number from branch ──────────────────────────────────────
if [[ -z "$issue_number" && "$branch" =~ $BRANCH_PATTERN ]]; then
  issue_number=$(sed -E 's#^(fix|feature|issue)/(issue-)?([0-9]+)-.*#\3#' <<<"$branch")
fi

# ── 3. PR body checks (only if a body file was supplied) ────────────────────
pr_body=
if [[ -n "$pr_body_file" ]]; then
  if [[ ! -f "$pr_body_file" ]]; then
    errors+=("PR body file '${pr_body_file}' not found.")
  else
    pr_body=$(cat "$pr_body_file")

    # 3a. Detect raw placeholder "Refs #" with no number
    if echo "$pr_body" | grep -qiE 'Refs\s+#[^0-9]|Refs\s+#$'; then
      errors+=("PR body contains a raw 'Refs #' placeholder with no issue number. Replace it with 'Refs #${issue_number:-<issue>}' before opening the PR.")
    fi

    # 3b. Count issue refs
    ref_count=$(echo "$pr_body" | agent_extract_issue_refs | jq 'length')
    if [[ "$ref_count" -eq 0 ]]; then
      errors+=("PR body contains no issue reference. Add exactly one 'Refs #${issue_number:-<issue>}' line.")
    elif [[ "$ref_count" -gt 1 ]]; then
      errors+=("PR body contains ${ref_count} issue references; exactly one is required.")
    elif [[ -n "$issue_number" ]]; then
      # 3c. Ref number must match branch issue
      linked_issue=$(echo "$pr_body" | agent_extract_issue_refs | jq -r '.[0]')
      if [[ "$linked_issue" != "$issue_number" ]]; then
        errors+=("PR body references issue #${linked_issue} but the branch is for issue #${issue_number}. Fix the 'Refs #' line to match the branch issue number.")
      fi
    fi

    # 3d. autofix-ok safety
    if [[ "$autofix_ok" == true ]]; then
      errors+=("autofix-ok cannot be requested at preflight time (it requires a non-draft PR). Pass --autofix-ok only when promoting via promote-pr.sh --ready --autofix-ok.")
    fi
  fi
fi

# ── 4. Claim availability (optional, requires GitHub network) ───────────────
if [[ "$check_claim" == true && -n "$issue_number" ]]; then
  comments=$(agent_fetch_comments "$repo" "$issue_number" 2>/dev/null || true)
  if [[ -n "$comments" ]]; then
    events=$(printf '%s' "$comments" | agent_collect_events)

    # Replicate same-branch-preference logic (mirrors PR Policy)
    # Pass events via env var (not stdin) so the heredoc does not conflict with <<< redirection.
    claim_status=$(PREFLIGHT_EVENTS="$events" python3 - "$branch" "$issue_number" <<'PY'
import json, sys, os
from datetime import datetime, timezone

head_branch = sys.argv[1]
issue_number = int(sys.argv[2])

def parse(v):
    if not v: return None
    try: return datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except Exception: return None

events = json.loads(os.environ.get("PREFLIGHT_EVENTS", "[]"))
claims = {}
terminals = set()

for event in events:
    run = event.get("run_id")
    typ = event.get("type")
    if not run: continue
    if typ == "claim":
        claims[run] = event
    elif typ == "heartbeat" and run in claims:
        claims[run] = {**claims[run], "lease_expires_at": event.get("lease_expires_at", claims[run].get("lease_expires_at")), "last_event": event}
    elif typ in {"release", "blocked", "completed", "superseded"}:
        terminals.add(run)

for run in terminals:
    claims.pop(run, None)

now = datetime.now(timezone.utc)
active_claims = [c for c in claims.values() if parse(c.get("lease_expires_at")) and parse(c.get("lease_expires_at")) > now]
active_claims.sort(key=lambda e: (e.get("claimed_at") or "", e.get("_comment_id", 0)))

# Prefer same-branch match among active claims
same_branch_active = [c for c in active_claims if c.get("branch") == head_branch]
other_branch_active = [c for c in active_claims if c.get("branch") != head_branch]

settled_claims = [c for c in claims.values() if c.get("run_id") in {e for e in terminals}]
# Note: terminals were popped from claims above; recollect settled from events directly
all_claims_map = {}
terminal_runs = set()
for event in events:
    run = event.get("run_id")
    typ = event.get("type")
    if not run: continue
    if typ == "claim":
        all_claims_map[run] = event
    elif typ in {"release", "completed"}:
        terminal_runs.add(run)

settled = [c for run, c in all_claims_map.items() if run in terminal_runs]
settled.sort(key=lambda e: (e.get("claimed_at") or "", e.get("_comment_id", 0)))
matching_settled = next((c for c in reversed(settled) if c.get("branch") == head_branch), None)

if same_branch_active:
    print(json.dumps({"status": "ok", "match": "same-branch-active", "run_id": same_branch_active[0].get("run_id")}))
elif other_branch_active:
    conflict_branch = other_branch_active[0].get("branch", "unknown")
    print(json.dumps({"status": "conflict", "conflict_branch": conflict_branch, "run_id": other_branch_active[0].get("run_id")}))
elif matching_settled:
    print(json.dumps({"status": "ok", "match": "settled-same-branch", "run_id": matching_settled.get("run_id")}))
else:
    print(json.dumps({"status": "missing"}))
PY
)

    status=$(jq -r '.status' <<<"$claim_status")
    case "$status" in
      ok)
        ;;
      conflict)
        conflict_branch=$(jq -r '.conflict_branch' <<<"$claim_status")
        conflict_run=$(jq -r '.run_id' <<<"$claim_status")
        errors+=("Conflicting active claim exists for issue #${issue_number} on branch '${conflict_branch}' (run: ${conflict_run}). That stale/conflicting claim must be released before this branch can be used. Run: GITHUB_REPOSITORY=${repo} scripts/agent-coordination/release-claim.sh --issue ${issue_number} --run-id ${conflict_run} --type superseded --reason 'superseded by ${branch}'")
        ;;
      missing)
        errors+=("No active or settled claim found for issue #${issue_number} on branch '${branch}'. Claim the issue first: GITHUB_REPOSITORY=${repo} scripts/agent-coordination/start-issue.sh --issue ${issue_number} --branch ${branch}")
        ;;
    esac
  fi
fi

# ── 5. Summary ───────────────────────────────────────────────────────────────
if [[ "${#errors[@]}" -eq 0 ]]; then
  [[ "$quiet" == true ]] || echo "✓ Preflight passed for branch '${branch}' (issue #${issue_number:-unknown})."
  if [[ "${#warnings[@]}" -gt 0 ]]; then
    for w in "${warnings[@]}"; do
      echo "⚠  $w"
    done
  fi
  exit 0
else
  echo "✗ Preflight failed for branch '${branch}' (issue #${issue_number:-unknown})."
  echo ""
  for i in "${!errors[@]}"; do
    echo "  $((i+1)). ${errors[$i]}"
  done
  echo ""
  echo "Fix the above issues before opening or promoting the PR."
  exit 1
fi
