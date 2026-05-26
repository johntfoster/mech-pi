#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/lib/agent_issue_workflow.sh"
agent_require_tools

repo=$(agent_repo)
ready=false
add_autofix=false
pr_number=
branch_override=
run_id=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ready)
      ready=true; shift ;;
    --autofix-ok)
      add_autofix=true; shift ;;
    --pr)
      pr_number=${2:-}; shift 2 ;;
    --branch)
      branch_override=${2:-}; shift 2 ;;
    --run-id)
      run_id=${2:-}; shift 2 ;;
    --*)
      agent_fail "Unknown option: $1" 2 '{}' ;;
    *)
      agent_fail "Unexpected argument: $1" 2 '{}' ;;
  esac
done

repo_root=$(git -C "$ROOT_DIR/.." rev-parse --show-toplevel)
branch=${branch_override:-$(git -C "$repo_root" branch --show-current)}
agent_validate_branch_name "$branch"
issue_number=$(sed -E 's#^(fix|feature|issue)/(issue-)?([0-9]+)-.*#\3#' <<<"$branch")

if [[ -z "$pr_number" ]]; then
  pr_json=$(gh pr view --repo "$repo" "$branch" --json number,state,isDraft,baseRefName,headRefName,body,labels,url 2>/dev/null || true)
else
  pr_json=$(gh pr view "$pr_number" --repo "$repo" --json number,state,isDraft,baseRefName,headRefName,body,labels,url)
fi

[[ -n "$pr_json" ]] || agent_fail 'PR not found for branch.' 4 "$(jq -n --arg branch "$branch" '{branch:$branch}')"
pr_number=$(jq -r '.number' <<<"$pr_json")
pr_body=$(jq -r '.body // ""' <<<"$pr_json")
pr_state=$(jq -r '.state' <<<"$pr_json")
pr_draft=$(jq -r '.isDraft' <<<"$pr_json")
base_ref=$(jq -r '.baseRefName' <<<"$pr_json")
head_ref=$(jq -r '.headRefName' <<<"$pr_json")
[[ "$pr_state" == "OPEN" ]] || agent_fail 'PR must be open.' 4 "$(jq -n --argjson pr "$pr_number" '{pr:$pr}')"
[[ "$head_ref" == "$branch" ]] || agent_fail 'PR head branch does not match current branch.' 4 "$(jq -n --arg branch "$branch" --arg head_ref "$head_ref" '{branch:$branch,head_ref:$head_ref}')"
[[ "$base_ref" == "main" ]] || agent_fail 'PR must target main.' 4 "$(jq -n --arg base_ref "$base_ref" '{base_ref:$base_ref}')"

issue_refs=$(printf '%s' "$pr_body" | agent_extract_issue_refs)
ref_count=$(jq 'length' <<<"$issue_refs")
[[ "$ref_count" -eq 1 ]] || agent_fail 'PR body must link exactly one issue.' 4 "$(jq -n --argjson issues "$issue_refs" '{issues:$issues}')"
linked_issue=$(jq -r '.[0]' <<<"$issue_refs")
[[ "$linked_issue" == "$issue_number" ]] || agent_fail 'PR issue linkage must match branch issue number.' 4 "$(jq -n --argjson branch_issue "$issue_number" --argjson linked_issue "$linked_issue" '{branch_issue:$branch_issue,linked_issue:$linked_issue}')"

issue_json=$(agent_fetch_issue "$repo" "$linked_issue")
hold_open_for_human_review=$(jq -r --arg target_label "$LABEL_HUMAN_REVIEW_REQUIRED" '[.labels[]?.name] | index($target_label) != null' <<<"$issue_json")

comments=$(agent_fetch_comments "$repo" "$issue_number")
events=$(printf '%s' "$comments" | agent_collect_events)
active_run_id=$(printf '%s' "$events" | agent_active_claim_run_id)
if [[ -n "$run_id" ]]; then
  [[ "$active_run_id" == "$run_id" ]] || agent_fail 'Provided run-id is not the active claim.' 4 "$(jq -n --arg run_id "$run_id" --arg active_run_id "$active_run_id" '{run_id:$run_id,active_run_id:$active_run_id}')"
elif [[ -z "$active_run_id" ]]; then
  agent_fail 'No active claim metadata found for linked issue.' 4 "$(jq -n --argjson issue "$issue_number" '{issue:$issue}')"
fi

had_autofix=$(jq -e '.labels[].name | select(. == "autofix-ok")' <<<"$pr_json" >/dev/null && echo true || echo false)

changes=()
# When promoting to ready, normalize Refs #<issue> → Closes #<issue> so merged PRs
# auto-close the linked issue without manual cleanup, unless the linked issue is
# explicitly held open for final human review.
if [[ "$ready" == true ]]; then
  if [[ "$hold_open_for_human_review" == "true" ]]; then
    normalized_body=$(printf '%s' "$pr_body" | ISSUE_LINK="$linked_issue" agent_hold_open_issue_ref)
  else
    normalized_body=$(printf '%s' "$pr_body" | ISSUE_LINK="$linked_issue" agent_normalize_issue_ref)
  fi
  if [[ "$normalized_body" != "$pr_body" ]]; then
    # Use the REST API directly to avoid gh pr edit exiting non-zero on
    # GitHub's Projects Classic GraphQL deprecation warning.
    gh api "repos/$repo/pulls/$pr_number" -X PATCH --input - <<JSON >/dev/null
$(jq -n --arg body "$normalized_body" '{body:$body}')
JSON
    pr_body="$normalized_body"
    if [[ "$hold_open_for_human_review" == "true" ]]; then
      changes+=("preserved_refs_for_human_review")
    else
      changes+=("normalized_refs_to_closes")
    fi
  fi
fi
if [[ "$ready" == true && "$pr_draft" == true ]]; then
  gh pr ready "$pr_number" --repo "$repo" >/dev/null
  pr_draft=false
  changes+=("marked_ready")
fi
if [[ "$add_autofix" == true && "$pr_draft" == true ]]; then
  agent_fail 'autofix-ok cannot be applied to a draft PR.' 4 "$(jq -n --argjson pr "$pr_number" '{pr:$pr}')"
fi
if [[ "$add_autofix" == true && "$had_autofix" == false ]]; then
  gh api "repos/$repo/issues/$pr_number/labels" -X POST --input - <<JSON >/dev/null
{"labels":["autofix-ok"]}
JSON
  had_autofix=true
  changes+=("added_autofix_ok")
fi

ready_now=false
autofix_now=false
[[ "$pr_draft" == false ]] && ready_now=true
[[ "$had_autofix" == true ]] && autofix_now=true
changes_json=$(printf '%s\n' "${changes[@]-}" | jq -R . | jq -s 'map(select(length>0))')

jq -n \
  --argjson pr "$pr_number" \
  --arg branch "$branch" \
  --argjson issue "$issue_number" \
  --arg active_run_id "$active_run_id" \
  --argjson ready "$ready_now" \
  --argjson autofix_ok "$autofix_now" \
  --argjson human_review_hold "$hold_open_for_human_review" \
  --argjson changes "$changes_json" \
  '{ok:true,pr:$pr,branch:$branch,issue:$issue,active_run_id:$active_run_id,ready:$ready,autofix_ok:$autofix_ok,human_review_hold:$human_review_hold,changes:$changes}'
