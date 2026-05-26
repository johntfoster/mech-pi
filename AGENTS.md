# AGENTS.md

Repository-specific playbook for coding agents working on `mech-pi`.

## Project purpose

`mech-pi` is a pi extension package for mechanics-aware LaTeX research and continuum-mechanics paper development for pi.

## Two-layer workflow model

This repo uses a lightweight version of the issue-first workflow adapted from TeamSpace:

1. **Generic workflow spec**: `docs/agent-extension-workflow-spec.md` is the canonical, tool-agnostic reference for issue pickup, branch/PR policy, verification, and release.
2. **Repo-specific adapter**: this `AGENTS.md` file adds `mech-pi`-specific guardrails, verification, and documentation expectations.

The generic spec is the source of truth for workflow sequence. This file is the source of truth for project-specific behavior.

## Read order before you change anything

Read these files in order every time you start a non-trivial task:

1. `STATUS.md`
2. `CONTRIBUTING.md`
3. `README.md`
4. `docs/agent-extension-workflow-spec.md`
5. `docs/agent-issue-workflow.md`
6. `docs/agent-runbook.md`
7. `AGENTS.md`
8. Adjacent docs for the feature you touch

If a workflow is not documented in those files or in `.github/workflows/*`, do not assume it exists.

## Core operating rules

- Start substantive work from a GitHub Issue whenever possible. If a human asks for work without an issue, first search existing open issues; create a new issue only when no suitable issue exists.
- Do not begin substantial edits until the issue is claimed with `scripts/agent-coordination/start-issue.sh` or `claim-issue.sh`.
- Use one issue, one branch, and one PR for each independently reviewable change.
- Use issue branches: `issue/<number>-<slug>`, `fix/<number>-<slug>`, or `feature/<number>-<slug>`.
- Read the full issue thread after claim and synthesize current issue truth before planning or editing.
- Open a draft PR early with exactly one short issue reference (`Refs #<issue>` while draft).
- Keep claims alive while work, CI, or PR review is active; release them when blocked, handed off, or completed.
- Keep changes tight to the claimed issue.
- Do not run destructive local commands or publish/release operations without explicit user approval.

## Repository layout

- `extensions/mech-pi.ts`
- `skills/mechanics-research/SKILL.md`
- `prompts/`
- `docs/`
- `scripts/`

## Project-specific guardrails

- Treat the LaTeX manuscript repository as source of truth; do not rely on stale chat memory for mechanics claims.
- Use `mech_ingest`, equation-focused inspection, and TeX source citations when validating paper behavior.
- Keep mechanics claims honest: separate assumptions, definitions, derivations, constitutive restrictions, and conjectures.
- Preserve terminal image UX, vim-style prompt/copy modes, and equation rendering behavior when editing the extension.
- If changing user-facing commands, update `README.md`, `docs/tools-and-commands.md`, and the relevant keybinding/equation-editor docs.

## Verification

Run the smallest meaningful checks for the change. Expected checks for this repo:

- `npm ci`
- `npm run typecheck`

For docs/workflow-only changes, also run:

- `git diff --check`
- `bash -n scripts/agent-coordination/*.sh scripts/gh-* scripts/lib/*.sh` when scripts changed

If you cannot run an expected check, say why in the PR and handoff.

## Pull request expectations

- Target `main`.
- Link exactly one issue in the PR body.
- Keep PRs draft until implementation and verification are complete.
- Use `scripts/agent-coordination/draft-pr-body.sh --issue <n> --run-id "$RUN_ID"` for PR body generation.
- Run `scripts/agent-coordination/preflight-check.sh --pr-body /path/to/body.md --check-claim` before opening or promoting when possible.
- Use `scripts/agent-coordination/promote-pr.sh --ready --autofix-ok --run-id "$RUN_ID"` only after checks are green and the PR is ready for merge policy.

## Quick reference

```bash
# Claim + branch + isolated worktree
scripts/agent-coordination/start-issue.sh --issue <n> --agent-label <label>

# Refresh active lease
scripts/agent-coordination/heartbeat-claim.sh --issue <n> --run-id "$RUN_ID" --notes "status"

# Generate draft PR body
scripts/agent-coordination/draft-pr-body.sh --issue <n> --run-id "$RUN_ID" > /tmp/pr-body.md

# Preflight metadata
scripts/agent-coordination/preflight-check.sh --pr-body /tmp/pr-body.md --check-claim

# Promote when ready
scripts/agent-coordination/promote-pr.sh --ready --autofix-ok --run-id "$RUN_ID"

# Release claim
scripts/agent-coordination/release-claim.sh --issue <n> --run-id "$RUN_ID" --type completed --reason "merged"
```

## Existing mech-pi UX invariants

`mech-pi` intentionally adds vim-style prompt editing, prefix commands, and full-screen copy/navigation for inline image workflows.

- Prompt editor: vim-style modal editing with INSERT, NORMAL, VISUAL, and VISUAL LINE modes.
- The prompt mode display should remain concise: show mode names like `INSERT`, `NORMAL`, `VISUAL`, `VISUAL LINE`, or `PREFIX`, not long command hints.
- `Enter` submits prompts; `Shift-Enter` inserts newlines; prompt backspace should delete exactly one character.
- `Ctrl-a` then `]` enters full-screen copy/navigation mode over the rendered pi screen.
- `Ctrl-a` then `[` returns from copy mode to the prompt.
- Full-screen copy mode should support common non-insert vim movement and selection commands.
- Yanking from full-screen copy mode should return to the prompt immediately in `NORMAL` mode so the user can paste with `p`/`P`.
- If a linewise visual selection touches an inline rendered equation image, `y` should yank the underlying LaTeX source and `Y` should yank the PNG image itself when possible.
- In copy mode, represent an equation image with one centered `[latex_image.png]` placeholder while preserving source/PNG metadata across all image rows.

## Manuscript editing behavior

- `/mechedit` should search from source-grounded paper-map data and open the best matching `file:line`.
- External mode remains the default. Honor `MECHPI_EDITOR`, then `VISUAL`, then `EDITOR`, then `nvim`; use `MECHPI_EDITOR_TERMINAL` or Kitty for terminal editors when appropriate.
- `/mechedit --inline` and `MECHPI_EDIT_MODE=inline` open the integrated modal source editor. It should show source line numbers, LaTeX/BibTeX-aware highlighting, fuzzy Tab completions for LaTeX commands/refs/cites/environments/symbols, support `:<line>` jumps, refuse to overwrite files changed on disk while open, and rebuild `.mechpi/paper-map.json` after saves.
- Prefer the integrated modal editor over embedding a live nvim session inside pi's TUI.
- For direct `file.tex:line` input, bypass scoring and open that exact location.
- After changing search/open behavior, update `README.md`, `docs/tools-and-commands.md`, and this file.

## Mechanics-paper behavior

- Prefer precise TeX inspection over broad guesses.
- Use `mech_ingest` before making detailed claims about a paper's structure or notation.
- Equation-focused tools should return exact source, nearby prose, labels, symbols/macros, and warnings where relevant.
- Do not silently rewrite manuscript source unless the original target block is uniquely identified.

## Terminal image behavior

Rendered LaTeX previews should remain readable. Avoid independent width/height scaling that can distort aspect ratio. Prefer high-resolution PNG generation and width-driven terminal scaling. Do not assume Kitty can display SVG payloads directly; use PNG for terminal image compatibility.

Be careful with Kitty image IDs and cleanup. Inline images may occupy multiple terminal rows; copy-mode source mapping should account for blank rows associated with an image, not only the line that contains the escape sequence. Keep the visible placeholder single and centered, not repeated on every image row.
