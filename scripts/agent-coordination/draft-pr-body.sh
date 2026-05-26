#!/usr/bin/env bash
# draft-pr-body.sh — Generate a pre-filled draft PR body for a pi extension issue branch.
#
# Usage:
#   scripts/agent-coordination/draft-pr-body.sh --issue <n> [--branch <branch>] [--run-id <run_id>] [--agent-label <label>] [--output <file>]
#
# Prints a ready-to-use PR body to stdout (or writes to --output file).
# The body includes exactly one "Refs #<issue>" line, agent metadata fields,
# and a reminder about promotion behavior.
#
# Typical use:
#   body=$(GITHUB_REPOSITORY=johntfoster/mech-pi \
#     scripts/agent-coordination/draft-pr-body.sh --issue 537 --run-id "$RUN_ID")
#   gh pr create --draft --body "$body" ...
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/lib/agent_issue_workflow.sh"

issue_number=
branch=
run_id=
agent_label=
output_file=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue)        issue_number=${2:-}; shift 2 ;;
    --branch)       branch=${2:-}; shift 2 ;;
    --run-id)       run_id=${2:-}; shift 2 ;;
    --agent-label)  agent_label=${2:-}; shift 2 ;;
    --output)       output_file=${2:-}; shift 2 ;;
    --*)            agent_fail "Unknown option: $1" 2 '{}' ;;
    *)              agent_fail "Unexpected argument: $1" 2 '{}' ;;
  esac
done

# Resolve branch from git if not supplied
repo_root=$(git -C "$ROOT_DIR/.." rev-parse --show-toplevel)
if [[ -z "$branch" ]]; then
  branch=$(git -C "$repo_root" branch --show-current 2>/dev/null || true)
fi

# Derive issue number from branch if not supplied
if [[ -z "$issue_number" && -n "$branch" ]]; then
  derived=$(sed -E 's#^(fix|feature|issue)/(issue-)?([0-9]+)-.*#\3#' <<<"$branch" 2>/dev/null || true)
  if [[ "$derived" =~ ^[0-9]+$ ]]; then
    issue_number=$derived
  fi
fi

[[ -n "$issue_number" && "$issue_number" =~ ^[0-9]+$ ]] || agent_fail 'Issue number is required (--issue <n> or derivable from branch name).' 2 '{}'

# Resolve agent label and run_id from environment if not supplied
if [[ -z "$agent_label" ]]; then
  agent_label=$(agent_identity_label)
fi
if [[ -z "$run_id" ]]; then
  run_id=${RUN_ID:-}
fi

# Compose the body
body="## Linked issue
- Refs #${issue_number}

## Agent coordination metadata
- Agent label: ${agent_label}
- Run ID: ${run_id:-<fill in RUN_ID>}
- Claim branch: ${branch}

## Summary
<!-- Describe what this PR does -->

## Notes
- This is a draft PR. Keep \`Refs #${issue_number}\` until implementation is verified.
- Run \`GITHUB_REPOSITORY=$(agent_repo 2>/dev/null || echo '<owner/repo>') scripts/agent-coordination/preflight-check.sh\` locally to validate workflow metadata.
- Run \`scripts/agent-coordination/promote-pr.sh --ready\` to mark ready; the script normalizes \`Refs #${issue_number}\` → \`Closes #${issue_number}\` automatically.
- \`autofix-ok\` is only valid on non-draft PRs with a single matching issue reference."

if [[ -n "$output_file" ]]; then
  printf '%s\n' "$body" > "$output_file"
  printf 'PR body written to %s\n' "$output_file" >&2
else
  printf '%s\n' "$body"
fi
