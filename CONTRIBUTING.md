# Contributing

Thanks for improving `mech-pi`. This repository uses an issue-first workflow for human and agent contributors.

## Start with an issue

Before opening a branch, check whether an open issue already covers the task. If not, create one with:

- summary and motivation
- intended scope
- acceptance criteria
- expected verification

Agents should claim the issue before substantive edits:

```bash
scripts/agent-coordination/start-issue.sh --issue <n> --agent-label <your-name>
```

## Branches

Use one of:

- `issue/<number>-<slug>`
- `fix/<number>-<slug>`
- `feature/<number>-<slug>`

Keep one independently reviewable change per issue branch.

## Pull requests

- Target `main`.
- Open a draft PR early for visibility.
- Include exactly one short issue reference: `Refs #<n>` while draft, or `Closes #<n>` when ready to close.
- Do not use repo-qualified issue refs in the PR body.
- Run the expected checks and include results in the PR.

Generate a body with:

```bash
scripts/agent-coordination/draft-pr-body.sh --issue <n> --run-id "$RUN_ID" > /tmp/pr-body.md
```

## Verification

Expected checks for this repo:

- `npm ci`
- `npm run typecheck`

Docs/workflow-only changes should also pass `git diff --check`.

## Release and publishing

Do not tag releases, publish packages, or change install metadata without explicit maintainer intent.
