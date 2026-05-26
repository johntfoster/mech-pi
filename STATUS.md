# STATUS

Current status for `mech-pi`. Update this file when implementation status or workflow expectations materially change.

## Package state

- Package type: pi extension package.
- Primary purpose: mechanics-aware LaTeX research and continuum-mechanics paper development for pi.
- Default branch: `main`.
- Distribution: GitHub/local pi package install.

## Active surfaces

- `extensions/mech-pi.ts`
- `skills/mechanics-research/SKILL.md`
- `prompts/`
- `docs/`
- `scripts/`

## Expected verification

- `npm ci`
- `npm run typecheck`

## Workflow state

- Issue-first agent workflow is documented in `AGENTS.md`, `CONTRIBUTING.md`, and `docs/`.
- Agent coordination helpers live in `scripts/agent-coordination/` and emit `AGENT_CLAIM_V1` issue comments.
- GitHub PR policy expects issue-scoped branches and a single matching issue link in PR bodies.

## Project-specific notes

- Treat the LaTeX manuscript repository as source of truth; do not rely on stale chat memory for mechanics claims.
- Use `mech_ingest`, equation-focused inspection, and TeX source citations when validating paper behavior.
- Keep mechanics claims honest: separate assumptions, definitions, derivations, constitutive restrictions, and conjectures.
- Preserve terminal image UX, vim-style prompt/copy modes, and equation rendering behavior when editing the extension.
- If changing user-facing commands, update `README.md`, `docs/tools-and-commands.md`, and the relevant keybinding/equation-editor docs.
