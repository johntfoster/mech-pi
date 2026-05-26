# Agent Runbook

## Prerequisites

- `gh` authenticated for `johntfoster/mech-pi`
- `jq` installed
- `python3` installed
- Optional: `GITHUB_REPOSITORY=johntfoster/mech-pi` exported; helpers can also derive this from the GitHub `origin` remote.

## Start work

```bash
scripts/agent-coordination/start-issue.sh --issue <n> --agent-label <label> --notes "starting"
```

The helper returns JSON with `run_id`, `branch`, and `worktree_path`.

## Required after claim

Read every issue comment, then summarize current issue truth before planning or editing.

## Draft PR body

```bash
scripts/agent-coordination/draft-pr-body.sh --issue <n> --run-id "$RUN_ID" > /tmp/pr-body.md
```

## Preflight

```bash
scripts/agent-coordination/preflight-check.sh --pr-body /tmp/pr-body.md --check-claim
```

## Heartbeat

```bash
scripts/agent-coordination/heartbeat-claim.sh --issue <n> --run-id "$RUN_ID" --notes "status"
```

## Promote

```bash
scripts/agent-coordination/promote-pr.sh --ready --autofix-ok --run-id "$RUN_ID"
```

## Release

```bash
scripts/agent-coordination/release-claim.sh --issue <n> --run-id "$RUN_ID" --type completed --reason "merged"
```

Use `--type blocked --reason "..."` when blocked.
