# mech-pi

`mech-pi` is a pi package for mechanics-aware LaTeX paper development. It treats the manuscript repository as the source of truth and gives pi tools for paper-map ingestion, equation focus/editing, compilation, PDF preview, symbol search, and lightweight mechanics checks.

## Highlights

- Source-grounded research mode: the `.tex` files win over stale chat context.
- `.mechpi/paper-map.json` cache with root file, included TeX files, labels, refs, citations, equations, equation numbers from `.aux`, macros, bibliography keys, TODOs, and warnings.
- Equation focus by label, rendered PDF equation number, or source fragment.
- `/mechedit` natural-language/location search that opens the likely manuscript spot in an external editor or optional inline modal editor.
- Interactive equation editor with compiled/typeset PNG preview using the paper's actual LaTeX preamble.
- Compile/preview loop for LaTeX manuscripts.
- Citation workflows: find candidate papers, insert citations/BibTeX, open known references, and keep verified local copies.
- Reference ingestion/RAG: select local references/files, extract text, embed chunks when possible, and retrieve only relevant chunks on demand with `mech_retrieve`.
- Vim-style modal prompt editing plus tmux-like full-screen copy mode for running outside tmux.
- Copy-mode support for inline rendered equation images: yank LaTeX source or copy the PNG image itself.
- Optional local speech-to-text prompt input with push-to-talk and wake-word integration hooks.
- Opaque extension popups so underlying chat/status text does not bleed through dialogs.
- Mechanics-research skill and interrogation prompt templates.

## Install

From GitHub:

```bash
pi install git:github.com/johntfoster/mech-pi
```

During installation, `mech-pi` runs `npm postinstall` to create a package-local Python virtual environment at `.mechpi-python/` and install the default embedding backend, `sentence-transformers`. This enables `/mechingest` vector retrieval out of the box. Set `MECHPI_SKIP_PYTHON_DEPS=1` before installation only if you plan to use `MECHPI_EMBED_PROVIDER=openai`, `MECHPI_EMBED_PROVIDER=command`, or a custom `MECHPI_PYTHON`.

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
- `pdftoppm` from poppler-utils for PDF/PNG conversion,
- `xdg-open` or a configured viewer for opening `/mechingest` source documents,
- an inline-image-capable terminal for rendered equation previews, e.g. Kitty, Ghostty, WezTerm, or iTerm2,
- optional clipboard tools (`wl-copy`/`wl-paste`, `xclip`, or `xsel`) for system clipboard integration,
- optional external editor configuration (`MECHPI_EDITOR`, `VISUAL`, or `EDITOR`) for `/mechedit`,
- Python 3 with `venv`; the installer uses it to create `.mechpi-python/` and install `sentence-transformers` for default `/mechingest` embeddings,
- optional local speech tools for `/mechvoice`: a recorder (`sox`/`rec`, `parecord`, `ffmpeg`, or `arecord`) plus an STT backend (`MECHPI_STT_COMMAND`, `whisper.cpp`, Whisper CLI, or Vosk).

Equation editing still works without inline images; preview falls back to source/error text.

See [docs/terminal-images.md](docs/terminal-images.md) for SSH, Kitty, and tmux settings.

## Slash commands

```text
/mechmap [root.tex]       ingest and cache the paper map, including aux equation numbers when available
/mechedit query          fuzzy search and open inline editor (--external for external editor)
/mecheqedit eq:label     edit a focused equation block in-terminal
/mecheqedit number:2.14  edit by rendered PDF equation number
/mecheqedit contains:... edit the first equation containing a fragment
/mechaddcite prompt      find/select citation(s), summarize PDFs, update .bib, optionally insert into TeX
/mechciteedit query      edit a local BibTeX entry with a rendered reference preview
/mechgotocite query      fuzzy search local .bib entries and open the best paper website
/mechingest keywords     select refs/files, extract text, and build a local retrieval store
/mechcompile             run latexmk on the detected root and refresh aux equation numbers
/mechvoice status        configure/use local speech-to-text prompt input
/mechpreview             open root PDF
/mechquestions [topic]   ask pi to interrogate the development
```

See [docs/tools-and-commands.md](docs/tools-and-commands.md).

Configuration can be layered with `.mechpirc`: built-in defaults, then `$HOME/.mechpirc`, then a project-local `./.mechpirc` override. The files are re-read on `/reload` and use simple `KEY=value` / `export KEY=value` lines for `MECHPI_*` settings such as `MECHPI_REFERENCES_PATH`, `MECHPI_SUMMARY_MODEL`, or `MECHPI_COMMIT_MODEL`.

`/mechingest` builds `.mechpi/ingest/vector-store.json` with text embeddings when an embedding backend is available. Its source-confirmation flow now uses foreground h/l drill-down popup layers so each progressive prompt sits visually above the selector. By default it uses the free/open-source Python `sentence-transformers` backend (`sentence-transformers/all-MiniLM-L6-v2`) from the package-local `.mechpi-python/` environment installed by `npm postinstall`; configure `MECHPI_PYTHON`, `MECHPI_EMBED_MODEL`, `MECHPI_EMBED_PROVIDER=openai`, or `MECHPI_EMBED_PROVIDER=command`/`MECHPI_EMBED_COMMAND` as needed. Its selector distinguishes already-ingested green `✓` items from gray staged items, lets you summarize actual extracted text and open stored source documents externally, and only gives a BibTeX reference the gray staged check after the source file has been rectified: reuse a BibTeX `file` field, confirm a direct web download, enter a filepath, confirm a preferred-path match, or explicitly approve a broader `$HOME` search. Preferred paths are configurable with `MECHPI_INGEST_PREFERRED_PATHS`/`MECHPI_PREFERRED_PATHS` and default to `~/Downloads` and `~/Documents/References`. Filesystem searches show progress while scanning/scoring. Confirmed local sources are symlinked into `.mechpi/ingest/sources/` when possible to avoid duplicate PDF storage, while extracted text is still written under `.mechpi/ingest/text/`. Press `Enter` to exit the selector and build the vector store from the confirmed staged files. Later turns should use the `mech_retrieve` tool to query the local store and send only top matching chunks to the model. Set `MECHPI_AUTO_RAG=1` (or `MECHPI_AUTO_RETRIEVE=1`) only if you want automatic per-prompt retrieval injected into the system prompt.

## Prompt keybindings

`mech-pi` provides a vim-style prompt editor and a tmux-like full-screen copy mode:

- `Esc`: leave INSERT mode and enter NORMAL mode.
- `Enter`: send prompt in INSERT or NORMAL mode.
- `Shift-Enter`: insert a newline in INSERT mode.
- `v` / `V`: character/line visual selection in NORMAL mode.
- `J`: join lines in NORMAL mode; `Up`/`Down` cycle persistent prompt history with prefix matching.
- `Ctrl+Alt+Space`: toggle voice recording.
- Optional: set `MECHPI_VOICE_SPACE_HOLD=1`, then hold `Space` on an empty prompt for push-to-talk.
- `Ctrl-a` starts a tmux-like prefix that waits up to 2 seconds for the next key.
- `Ctrl-a` then `c`: create a new mech-pi logical pane; `Ctrl-a` then `n` / `p`: switch to the next/previous pane; `Ctrl-a` then `1` ... `9`: jump directly to that numbered pane.
- `Ctrl-a` then `]`: enter full-screen copy/navigation mode.
- `Ctrl-a` then `[`: return from copy mode to the prompt in `NORMAL` mode.
- Commands/dialogs return to `NORMAL` mode when prompt text is present and `INSERT` mode when the prompt is empty; full-screen copy mode returns in `NORMAL` mode so `p`/`P` can paste immediately.
- In linewise visual copy mode, `y` over an equation image yanks the LaTeX source and `Y` copies the PNG image when supported.

See [docs/keybindings.md](docs/keybindings.md).

## Example prompts

```text
ingest the paper and show me the theory map
focus equation eq:local-entropy-inequality and challenge it
focus equation number 2.14 and render it with its PDF number
open an editable focus panel for equation eq:local-entropy-inequality
find all uses of \rho_\alpha and tell me if notation drifts
/mechaddcite We need a citation supporting the sentence: Such swelling can cause fracturing in rock formations. I recall a city in southern Germany where drilling into an anhydrite formation caused uplift.
compile, summarize errors, and fix the first LaTeX issue
ask me skeptical mixture-theory questions about the mass transfer terms
review section 3 like a thermodynamics referee
```

In the citation picker, drilling into a candidate prefers an existing BibTeX `file` attachment, otherwise tries to download an accessible PDF to `/tmp`, extracts text, and summarizes it with `MECHPI_SUMMARY_MODEL` (default `openai/gpt-5.4`, no-thinking fast/priority mode). When a selected citation is added, any downloaded PDF is moved into `MECHPI_REFERENCES_PATH`/`MECHPI_REFERENCE_PATH` (default `~/Documents/References`) and the BibTeX `file` field records the path.

## Manuscript and equation editing

Open a likely manuscript location in the integrated modal source editor, or use `--external` for your configured external editor. Prompt searches rebuild the map from `main.tex`, score filenames and text across linked chapters/appendices, then show a selector when there are multiple fuzzy matches. Filename matches open the whole file:

```text
/mechedit entropy inequality
/mechedit eq:mom_gas
/mechedit sections/model.tex:120
```

Open the in-terminal focused equation editor:

```text
/mecheqedit eq:mom_gas
/mecheqedit number:2.14
```

The editor renders the selected equation through the manuscript preamble, displays a compiled PNG preview when possible, and edits the exact LaTeX environment block below it. When the paper map has `.aux` number data, isolated previews preserve the original PDF equation number with a temporary `\tag{...}` without changing the source. Number lookup is exact for labeled equations and explicit `\tag{...}` entries; unlabeled automatically numbered equations are not identifiable from standard `.aux` files. On save, `mech-pi` replaces the source block and rebuilds `.mechpi/paper-map.json`.

`/mechciteedit query` opens the same in-terminal editor for a local BibTeX entry, with a formatted-reference PNG preview and a metadata-card fallback. It preserves the `.bib` file's line-ending style when saving.

For vim/nvim as the external editor used by `/mechedit`:

```bash
export MECHPI_EDITOR=nvim
# or
export VISUAL=nvim
# or
export EDITOR=nvim
```

By default, `/mechedit` opens the full source file in pi's modal popup editor with source line numbers, LaTeX/BibTeX-aware highlighting, fuzzy `Tab` completions for commands/refs/cites/environments/symbols, `:<line>` jumps, `:w`, and `:wq`/`Ctrl+S` saving. Use `/mechedit --external query` or `MECHPI_EDIT_MODE=external` to launch an external editor session. For terminal editors, external mode opens a new Kitty window when available; set `MECHPI_EDITOR_TERMINAL` to override the terminal launcher.

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
