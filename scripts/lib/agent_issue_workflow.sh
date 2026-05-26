#!/usr/bin/env bash
set -euo pipefail

AGENT_COMMENT_MARKER='<!-- AGENT_CLAIM_V1 -->'
DEFAULT_TTL_SECONDS=7200
DEFAULT_HEARTBEAT_SECONDS=1800
LABEL_READY='agent:ready'
LABEL_CLAIMED='agent:claimed'
LABEL_BLOCKED='agent:blocked'
LABEL_REVIEW='agent:review'
LABEL_MERGED='agent:merged'
LABEL_HUMAN_REVIEW_REQUIRED='human:review-required'
LABEL_HUMAN_FINAL_REVIEW='human:final-review'
BRANCH_REGEX='^(fix|feature|issue)/(issue-)?[0-9]{1,6}(-[a-z0-9]+)+$'

agent_fail() {
  local message=${1:-error}
  local exit_code=${2:-1}
  local context=${3:-'{}'}
  jq -n --arg error "$message" --argjson context "$context" '{ok:false,error:$error,context:$context}' >&2
  exit "$exit_code"
}

agent_require_tools() {
  command -v gh >/dev/null 2>&1 || agent_fail 'gh CLI is required.' 3 '{}'
  command -v jq >/dev/null 2>&1 || agent_fail 'jq is required.' 3 '{}'
  command -v python3 >/dev/null 2>&1 || agent_fail 'python3 is required.' 3 '{}'
}

agent_now() { python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
PY
}

agent_add_seconds_utc() {
  local base_ts=$1 add_seconds=$2
  python3 - "$base_ts" "$add_seconds" <<'PY'
from datetime import datetime, timedelta, timezone
import sys
base = datetime.strptime(sys.argv[1], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
add = int(sys.argv[2])
print((base + timedelta(seconds=add)).strftime('%Y-%m-%dT%H:%M:%SZ'))
PY
}

agent_add_seconds() {
  local ts=$1 seconds=$2
  python3 - <<'PY' "$ts" "$seconds"
from datetime import datetime, timedelta, timezone
import sys
base = datetime.strptime(sys.argv[1], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
seconds = int(sys.argv[2])
print((base + timedelta(seconds=seconds)).strftime('%Y-%m-%dT%H:%M:%SZ'))
PY
}

agent_repo() {
  local repo=${GITHUB_REPOSITORY:-}
  if [[ -z "$repo" ]]; then
    local remote_url
    remote_url=$(git remote get-url origin 2>/dev/null || true)
    if [[ "$remote_url" =~ github.com[:/](.+/.+)\.git$ ]]; then
      repo=${BASH_REMATCH[1]}
    elif [[ "$remote_url" =~ github.com[:/](.+/.+)$ ]]; then
      repo=${BASH_REMATCH[1]}
    fi
  fi
  [[ -n "$repo" ]] || agent_fail 'GITHUB_REPOSITORY is required, e.g. owner/repo, or configure an origin GitHub remote.' 2 '{}'
  printf '%s\n' "$repo"
}

agent_identity_id() {
  if [[ -n "${OPENCLAW_AGENT_ID:-}" ]]; then printf '%s\n' "$OPENCLAW_AGENT_ID";
  elif [[ -n "${AGENT_ID:-}" ]]; then printf '%s\n' "$AGENT_ID";
  else printf 'local/%s\n' "$(hostname)"; fi
}

agent_identity_label() {
  if [[ -n "${OPENCLAW_AGENT_LABEL:-}" ]]; then printf '%s\n' "$OPENCLAW_AGENT_LABEL";
  elif [[ -n "${AGENT_LABEL:-}" ]]; then printf '%s\n' "$AGENT_LABEL";
  else basename "$(agent_identity_id)"; fi
}

agent_run_id() {
  printf '%s-%s\n' "$(agent_now)" "$(openssl rand -hex 4 2>/dev/null || python3 - <<'PY'
import secrets
print(secrets.token_hex(4))
PY
)"
}

agent_branch_name() {
  local issue_number=$1 title=$2 slug
  slug=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g; s/^$/issue/' | cut -c1-48)
  printf 'issue/%s-%s\n' "$issue_number" "$slug"
}

agent_issue_number() {
  local value=${AGENT_ISSUE_NUMBER:-}
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || agent_fail 'Issue number is required.' 2 '{}'
  printf '%s\n' "$value"
}

agent_ttl_seconds() {
  local ttl=${AGENT_TTL_SECONDS:-$DEFAULT_TTL_SECONDS}
  [[ "$ttl" =~ ^[0-9]+$ ]] && (( ttl >= 60 )) || agent_fail 'ttl-seconds must be an integer >= 60.' 2 '{}'
  printf '%s\n' "$ttl"
}

agent_json_block() {
  local payload=$1
  printf '%s\n```json\n%s\n```\n' "$AGENT_COMMENT_MARKER" "$payload"
}

agent_fetch_issue() {
  local repo=$1 issue=$2
  gh api -H 'Accept: application/vnd.github+json' "repos/$repo/issues/$issue"
}

agent_fetch_comments() {
  local repo=$1 issue=$2
  gh api -H 'Accept: application/vnd.github+json' --paginate "repos/$repo/issues/$issue/comments?per_page=100" | jq -s 'add'
}

agent_post_comment() {
  local repo=$1 issue=$2 body=$3
  gh api --method POST -H 'Accept: application/vnd.github+json' "repos/$repo/issues/$issue/comments" -f body="$body"
}

agent_set_labels() {
  local repo=$1 issue=$2 labels_json=$3
  gh api --method PATCH -H 'Accept: application/vnd.github+json' "repos/$repo/issues/$issue" --input - <<EOF2
{
  "labels": $labels_json
}
EOF2
}

agent_remove_label() {
  local repo=$1 issue=$2 label=$3
  gh api --method DELETE -H 'Accept: application/vnd.github+json' "repos/$repo/issues/$issue/labels/$(python3 - <<PY
import urllib.parse
print(urllib.parse.quote('''$label''', safe=''))
PY
)" >/dev/null 2>&1 || true
}

agent_collect_events() {
  python3 -c 'import json,re,sys; comments=json.load(sys.stdin); out=[]
for comment in comments:
    body=comment.get("body") or ""
    if "<!-- AGENT_CLAIM_V1 -->" not in body: continue
    m=re.search(r"```json\s*(\{[\s\S]*?\})\s*```", body)
    if not m: continue
    try: payload=json.loads(m.group(1))
    except Exception: continue
    payload["_comment_id"]=comment.get("id",0)
    payload["_comment_created_at"]=comment.get("created_at","")
    out.append(payload)
out.sort(key=lambda e:(e.get("claimed_at") or e.get("heartbeat_at") or e.get("released_at") or e.get("_comment_created_at") or "", e.get("_comment_id",0)))
print(json.dumps(out))'
}

agent_issue_has_pull_request() { jq -e '(.pull_request | type) == "object"' >/dev/null 2>&1; }

agent_active_claim_run_id() {
  python3 -c 'import json,sys; from datetime import datetime, timezone
parse=lambda v: datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) if v else None
events=json.load(sys.stdin); claims={}; terminals=set()
for event in events:
    run=event.get("run_id"); typ=event.get("type")
    if not run: continue
    if typ=="claim": claims[run]=event
    elif typ=="heartbeat" and run in claims: claims[run]={**claims[run], "lease_expires_at": event.get("lease_expires_at", claims[run].get("lease_expires_at")), "last_event": event}
    elif typ in {"release","blocked","completed","superseded"}: terminals.add(run)
for run in terminals: claims.pop(run, None)
now=datetime.now(timezone.utc)
active=[c for c in claims.values() if parse(c.get("lease_expires_at")) and parse(c.get("lease_expires_at")) > now]
active.sort(key=lambda e:(e.get("claimed_at") or "", e.get("_comment_id",0)))
print(active[-1].get("run_id","") if active else "")'
}

agent_validate_branch_name() {
  local branch=$1
  [[ "$branch" =~ $BRANCH_REGEX ]] || agent_fail 'Branch name must match fix/<issue>-slug, feature/<issue>-slug, or issue/<issue>-slug; legacy issue-<n> prefixes are also allowed (for example `issue/417-workflow-hardening`).' 2 "$(jq -n --arg branch "$branch" '{branch:$branch}')"
}

agent_extract_issue_refs() {
  python3 -c 'import json,re,sys; text=sys.stdin.read(); nums=sorted(set(int(m.group(1)) for m in re.finditer(r"(?:Fixes|Closes|Resolves|Refs)\s+#(\d+)", text, re.I))); print(json.dumps(nums))'
}

agent_normalize_issue_ref() {
  # Rewrites Refs #<issue> → Closes #<issue> (case-insensitive) in body read from stdin.
  # Required env: ISSUE_LINK=<issue_number>
  # Other link keywords (Closes, Fixes, Resolves) are left unchanged.
  python3 -c 'import re, os, sys
body = sys.stdin.read()
issue = os.environ["ISSUE_LINK"]
new_body = re.sub(r"(?i)\bRefs\s+#" + re.escape(str(issue)) + r"\b", "Closes #" + str(issue), body)
sys.stdout.write(new_body)'
}

agent_hold_open_issue_ref() {
  # Rewrites any closing keyword for the linked issue back to Refs #<issue>
  # so merge-time auto-close does not fire for human-review holds.
  # Required env: ISSUE_LINK=<issue_number>
  python3 -c 'import re, os, sys
body = sys.stdin.read()
issue = os.environ["ISSUE_LINK"]
pattern = re.compile(r"(?i)\b(?:Fixes|Closes|Resolves|Refs)\s+#" + re.escape(str(issue)) + r"\b")
new_body = pattern.sub("Refs #" + str(issue), body)
sys.stdout.write(new_body)'
}
