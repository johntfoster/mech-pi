# mech-pi

`mech-pi` is a pi package for mechanics-aware LaTeX paper development. It treats the manuscript repository as the source of truth and gives pi tools for paper-map ingestion, equation focus/editing, compilation, PDF preview, symbol search, and lightweight mechanics checks.

## Highlights

- Source-grounded research mode: the `.tex` files win over stale chat context.
- `.mechpi/paper-map.json` cache with root file, included TeX files, labels, refs, citations, equations, macros, bibliography keys, TODOs, and warnings.
- Equation focus by label or source fragment.
- Interactive equation editor with compiled/typeset PNG preview using the paper's actual LaTeX preamble.
- Compile/preview loop for LaTeX manuscripts.
- Mechanics-research skill and interrogation prompt templates.

## Install

From GitHub:

```bash
pi install git:github.com/johntfoster/mech-pi
```

From a local checkout:

```bash
pi install /home/jfoster/Documents/mech-pi
```

Use for one run without installing:

```bash
cd /path/to/paper
pi -e /home/jfoster/Documents/mech-pi
```

After editing or updating the extension, reload pi:

```text
/reload
```

See [docs/installation.md](docs/installation.md).

## Requirements

For full functionality, the machine running pi should have:

- `latexmk` for manuscript compilation,
- `pdflatex` for equation preview rendering,
- `pdftoppm` from poppler-utils for PNG conversion,
- an inline-image-capable terminal for rendered previews, e.g. Kitty, Ghostty, WezTerm, or iTerm2.

Equation editing still works without inline images; preview falls back to source/error text.

See [docs/terminal-images.md](docs/terminal-images.md) for SSH, Kitty, and tmux settings.

## Slash commands

```text
/mechmap [root.tex]       ingest and cache the paper map
/mecheqedit eq:label     edit a focused equation block in-terminal
/mecheqedit contains:... edit the first equation containing a fragment
/mechcompile             run latexmk on the detected root
/mechpreview             open root PDF
/mechquestions [topic]   ask pi to interrogate the development
```

See [docs/tools-and-commands.md](docs/tools-and-commands.md).

## Example prompts

```text
ingest the paper and show me the theory map
focus equation eq:local-entropy-inequality and challenge it
open an editable focus panel for equation eq:local-entropy-inequality
find all uses of \rho_\alpha and tell me if notation drifts
compile, summarize errors, and fix the first LaTeX issue
ask me skeptical mixture-theory questions about the mass transfer terms
review section 3 like a thermodynamics referee
```

## Equation editor

```text
/mecheqedit eq:mom_gas
```

The editor renders the selected equation through the manuscript preamble, displays a compiled PNG preview when possible, and edits the exact LaTeX environment block below it. On save, `mech-pi` replaces the source block and rebuilds `.mechpi/paper-map.json`.

For vim/nvim as the external editor:

```bash
export VISUAL=nvim
# or
export EDITOR=nvim
```

See [docs/equation-editor.md](docs/equation-editor.md).

## Terminal images over SSH/tmux

Inline equation previews can work over SSH with Kitty/Ghostty/WezTerm, but tmux may block image escape sequences.

For recent tmux versions, add to `~/.tmux.conf`:

```tmux
set -g allow-passthrough on
set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm-kitty:RGB"
```

If tmux says `allow-passthrough` is not an option, upgrade tmux or run pi outside tmux for inline previews.

Full notes: [docs/terminal-images.md](docs/terminal-images.md).

## Package layout

```text
extensions/mech-pi.ts                 main pi extension
skills/mechanics-research/SKILL.md    mechanics workflow skill
prompts/interrogate-mechanics.md      interrogation prompt
docs/                                documentation
demo/DEMO.md                         walkthrough
```

## Development

```bash
npm install
npm run typecheck
```

See [docs/development.md](docs/development.md) and [ROADMAP.md](ROADMAP.md).

## License

MIT. See [LICENSE](LICENSE).
