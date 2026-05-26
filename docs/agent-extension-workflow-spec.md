# Pi Extension Agent Workflow Spec

_Generic, tool-agnostic guide for coding agents working on `mech-pi`._

## 1. Mandatory reads

Read in order before substantive work:

1. `STATUS.md`
2. `CONTRIBUTING.md`
3. `README.md`
4. `docs/agent-issue-workflow.md`
5. `docs/agent-runbook.md`
6. `AGENTS.md`

## 2. Clarify the work

Determine whether the task is a bug, feature, docs/workflow change, refactor, or validation gap. Check existing open issues before creating a new one. Ask clarifying questions when scope or acceptance criteria are unclear.

## 3. Open or confirm the issue

Every non-trivial change should have a GitHub Issue. If the task is a parent/epic, split independent slices into child issues and run this workflow per child.

## 4. Claim the issue

Preferred:

```bash
scripts/agent-coordination/start-issue.sh --issue <n> --agent-label <label>
```

This claims the issue, derives an issue branch, and creates an isolated worktree. Capture the returned `run_id`.

## 5. Read the full issue thread

After claim, read every comment and synthesize:

- original ask
- latest authoritative guidance
- acceptance criteria
- blockers or superseding context
- whether the issue is a leaf change or a parent/epic

## 6. Draft PR early

Open a draft PR once the branch exists and direction is clear. PR bodies must contain exactly one same-repo issue reference such as `Refs #<n>`. Use `Closes #<n>` only when the PR should close the issue on merge.

## 7. Do the work

Keep changes scoped to the issue. Respect repo-specific guardrails in `AGENTS.md`. Update docs when user-facing behavior changes.

## 8. Verify

Expected checks:

- `npm ci`
- `npm run typecheck`

Docs/workflow-only changes: `git diff --check`; script changes: `bash -n`.

## 9. Keep the claim alive

Heartbeat while active:

```bash
scripts/agent-coordination/heartbeat-claim.sh --issue <n> --run-id "$RUN_ID" --notes "status"
```

## 10. Promote and monitor

When ready and verified:

```bash
scripts/agent-coordination/promote-pr.sh --ready --autofix-ok --run-id "$RUN_ID"
```

Then monitor until merged or explicitly release as blocked/handoff. Do not treat PR open/promoted as done.

## 11. Release cleanly

After merge or terminal handoff:

```bash
scripts/agent-coordination/release-claim.sh --issue <n> --run-id "$RUN_ID" --type completed --reason "merged"
```
