# AGENTS.md

Guidance for agents working on `mech-pi`.

## Project purpose

`mech-pi` is a pi extension package for mechanics-aware LaTeX research writing. Its main goal is to make pi a reliable companion for continuum mechanics, mixture theory, thermodynamics, and applied-mechanics manuscript development while keeping the LaTeX repository as the source of truth.

The extension should help users:

- inspect and reason from `.tex` source rather than stale chat context,
- ingest manuscript structure into `.mechpi/paper-map.json`,
- focus equations by label/source fragment with exact source context,
- open likely manuscript locations from natural-language prompts using `/mechedit`,
- edit equations in-terminal with vim-style controls and rendered LaTeX previews,
- compile and preview manuscripts,
- search notation/macros and catch lightweight LaTeX/mechanics consistency issues,
- work comfortably outside tmux so terminal image previews render and scroll correctly.

## Core principles

- Trust source files over conversation memory.
- When a project has `.mechpi/ingest/vector-store.json`, use the `mech_retrieve` tool for first-pass RAG before broad filesystem searches; `/mechingest` should maintain a local `AGENTS.md` block that documents this.
- For mechanics/theory claims, cite file paths, line numbers, and equation labels where possible.
- Clearly distinguish assumptions, definitions, derivations, constitutive restrictions, and conjectures.
- Keep the extension useful for research writing, not just code editing.
- Preserve terminal UX: rendered equations should be readable, scrollable, aspect-ratio-correct, and compatible with native Kitty/Ghostty/WezTerm/iTerm2 image protocols.
- Avoid breaking default pi behavior unless the custom behavior is intentional and documented.

## Important UX goals

`mech-pi` intentionally adds vim/tmux-like interaction because users may need to run pi outside tmux for inline image support.

- Prompt editor: vim-style modal editing with INSERT, NORMAL, VISUAL, and VISUAL LINE modes.
- The prompt mode display should remain concise: show mode names like `INSERT`, `NORMAL`, `VISUAL`, `VISUAL LINE`, or `PREFIX`, not long command hints.
- `Enter` submits prompts; `Shift-Enter` inserts newlines; prompt backspace should delete exactly one character.
- `Ctrl-a` then `]` enters full-screen copy/navigation mode over the rendered pi screen.
- `Ctrl-a` then `c` creates a logical pane, `n`/`p` switch next/previous, and `1`...`9` jump directly to pane numbers.
- `Ctrl-a` then `[` returns from copy mode to the prompt.
- Full-screen copy mode should support common non-insert vim movement and selection commands.
- Yanking from full-screen copy mode should return to the prompt immediately in `NORMAL` mode so the user can paste with `p`/`P`.
- If a linewise visual selection touches an inline rendered equation image, `y` should yank the underlying LaTeX source and `Y` should yank the PNG image itself when possible.
- In copy mode, represent an equation image with one centered `[latex_image.png]` placeholder, while preserving source/PNG metadata across all image rows.

## Development workflow

- Main extension: `extensions/mech-pi.ts`
- Docs: `docs/`
- Mechanics skill: `skills/mechanics-research/SKILL.md`
- Prompt templates: `prompts/`

After changes, run:

```bash
npm run typecheck
```

If user-facing behavior changes, update docs, especially:

- `README.md`
- `docs/keybindings.md`
- `docs/equation-editor.md`
- `docs/tools-and-commands.md`

## Manuscript editing behavior

- `/mechedit` should search from source-grounded paper-map data and open the best matching `file:line`.
- External mode remains the default for now. Honor `MECHPI_EDITOR`, then `VISUAL`, then `EDITOR`, then `nvim`; use `MECHPI_EDITOR_TERMINAL` or Kitty for terminal editors when appropriate.
- `/mechedit --inline` and `MECHPI_EDIT_MODE=inline` open the integrated modal source editor. It should show source line numbers, LaTeX/BibTeX-aware highlighting, fuzzy Tab completions for LaTeX commands/refs/cites/environments/symbols, support `:<line>` jumps, refuse to overwrite files changed on disk while open, and rebuild `.mechpi/paper-map.json` after saves.
- Prefer the integrated modal editor over embedding a live nvim session inside pi's TUI, which is not currently reliable.
- For direct `file.tex:line` input, bypass scoring and open that exact location.
- After changing search/open behavior, update `README.md`, `docs/tools-and-commands.md`, and this file.

## Mechanics-paper behavior

When adding or changing research features:

- Prefer precise TeX inspection over broad guesses.
- Use `mech_ingest` before making detailed claims about a paper's structure or notation.
- Equation-focused tools should return exact source, nearby prose, labels, symbols/macros, and warnings where relevant.
- Do not silently rewrite manuscript source unless the original target block is uniquely identified.

## Terminal image behavior

Rendered LaTeX previews should remain readable. Avoid independent width/height scaling that can distort aspect ratio. Prefer high-resolution PNG generation and width-driven terminal scaling. Do not assume Kitty can display SVG payloads directly; use PNG for terminal image compatibility.

Be careful with Kitty image IDs and cleanup. Inline images may occupy multiple terminal rows; copy-mode source mapping should account for blank rows associated with an image, not only the line that contains the escape sequence. Keep the visible placeholder single and centered, not repeated on every image row.
