# Agent Issue Workflow

This repository uses GitHub Issues and structured issue comments to coordinate human and agent work.

## Source of truth

- Claim records live in issue comments tagged with `<!-- AGENT_CLAIM_V1 -->`.
- Issue comments are the audit trail and acceptance-history source.
- Pull requests provide implementation visibility.
- GitHub Actions enforce branch/PR metadata where possible.

## Human-to-agent initiation

If a human describes work without an issue, the agent first searches open issues. Reuse a matching issue when possible; otherwise draft a new issue with scope and acceptance criteria before claiming.

## Standard flow

1. Claim with `scripts/agent-coordination/start-issue.sh --issue <n> --agent-label <label>`.
2. Read the full issue thread.
3. Synthesize current issue truth.
4. Open a draft PR early with exactly one `Refs #<n>` link.
5. Implement the scoped change.
6. Run expected verification.
7. Heartbeat while active.
8. Promote when ready.
9. Monitor until merge or release as blocked/handoff.
10. Release claim as completed after merge.

## Claim events

Event types: `claim`, `heartbeat`, `release`, `blocked`, `completed`, `superseded`. Reference schema: `docs/agent-claim-schema.json`.

## Branch and PR policy

Branches must match `issue/<n>-slug`, `fix/<n>-slug`, or `feature/<n>-slug`. PRs target `main` and link exactly one matching issue.

## Guardrails

- Do not stack unrelated issues in one branch.
- Do not use `autofix-ok` on draft PRs.
- Do not leave orphaned watchers or stale active claims.
- If blocked, release the claim with a reason.
