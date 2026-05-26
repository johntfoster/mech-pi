# Development

## Local setup

```bash
cd /home/jfoster/Documents/mech-pi
npm install
npm run typecheck
```

Use in a paper repository without installing:

```bash
cd /path/to/paper
pi -e /home/jfoster/Documents/mech-pi
```

After editing extension code in a running pi session:

```text
/reload
```

## Repository layout

```text
extensions/mech-pi.ts                 main pi extension
skills/mechanics-research/SKILL.md    source-grounded mechanics workflow skill
prompts/interrogate-mechanics.md      prompt template
docs/                                user/developer documentation
demo/DEMO.md                         walkthrough script
```

## Type checking

```bash
npm run typecheck
```

## Design notes

- The LaTeX repository is the source of truth.
- `.mechpi/paper-map.json` is a cache, not canonical state.
- Equation edits replace exact source blocks only if the original block is uniquely found in the source file.
- `/mechedit` defaults to an external-editor launcher, not an embedded nvim terminal. It ranks locations from the paper map, equation source, labels, section headings, and nearby prose, then opens `file:line`. With `--inline` or `MECHPI_EDIT_MODE=inline`, it opens the full source file in the integrated modal popup editor.
- The rendered preview uses the manuscript preamble rather than KaTeX so project macros/packages are respected.
- Equation previews are generated as high-resolution PNGs and terminal-scaled by width to preserve aspect ratio; SVG is not sent directly through Kitty's graphics protocol.
- The prompt and popup editors share a custom `CustomEditor` subclass that provides vim-style modal editing. Popup editors can display source line-number gutters, basic LaTeX/BibTeX highlighting, and `:<line>` source jumps. The prompt also provides a prefix-driven copy-mode overlay.
- Full-screen copy mode snapshots the rendered TUI, strips terminal escapes for text yanks, tracks equation image payload metadata by Kitty image id, and returns to prompt `NORMAL` mode after yanks; ordinary assistant-response completion returns the prompt to `INSERT` mode.
- Prompt backspace is handled by the custom editor in INSERT mode, with duplicate-event suppression for terminals such as Kitty.
- `/mecheqedit` temporarily suppresses assistant inline LaTeX image rendering while its overlay is open so stale Kitty image placements cannot cover the editor.

## Documentation checklist

When adding user-facing features, update the relevant docs before handing off:

- `README.md` for high-level feature lists and common commands.
- `docs/tools-and-commands.md` for slash commands, agent tools, and environment variables.
- `docs/keybindings.md` for prompt/copy-mode behavior.
- `docs/equation-editor.md` for focused equation editing behavior.
- `docs/terminal-images.md` for image rendering, clipboard, or terminal compatibility changes.
- `AGENTS.md` for instructions future coding agents should preserve.

## Publishing

This package can be installed by pi directly from GitHub:

```bash
pi install git:github.com/johntfoster/mech-pi
```

No npm publish is required for GitHub distribution.
