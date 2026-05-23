# Installation

`mech-pi` is a pi package containing one extension, one mechanics-research skill, and prompt templates for source-grounded LaTeX paper development.

## Install from GitHub

After the repository is published:

```bash
pi install git:github.com/johntfoster/mech-pi
```

The package `postinstall` step creates a package-local Python virtual environment at `.mechpi-python/` and installs `sentence-transformers`, the default embedding backend used by `/mechingest`. This means a GitHub install should be ready for vector retrieval without a separate `pip install` step.

Then start pi in a LaTeX paper repository:

```bash
cd /path/to/paper
pi
```

## Use without installing

```bash
cd /path/to/paper
pi -e /path/to/mech-pi
```

## Install from a local checkout

```bash
pi install /home/jfoster/Documents/mech-pi
```

## Reload after changes

If you edit the extension source while pi is running:

```text
/reload
```

## Requirements

Core pi packages are peer dependencies and are provided by pi when loading the package.

For default `/mechingest` embeddings, install Python 3 with `venv` support before installing `mech-pi`. The installer then runs:

```bash
python3 -m venv .mechpi-python
.mechpi-python/bin/python -m pip install sentence-transformers
```

`mech-pi` automatically uses that package-local Python. Override with `MECHPI_PYTHON=/path/to/python`, or skip the Python dependency step with `MECHPI_SKIP_PYTHON_DEPS=1` if you will use `MECHPI_EMBED_PROVIDER=openai` or `MECHPI_EMBED_PROVIDER=command` instead.

For LaTeX compilation and equation rendering, install:

- `latexmk` for `/mechcompile`
- `pdflatex` for equation preview rendering
- `pdftoppm` from poppler-utils for converting equation previews to PNG
- a terminal that supports inline images if you want rendered equation previews inside the TUI
- optional clipboard tools (`wl-clipboard`, `xclip`, or `xsel`) for copy/yank integration
- optional `nvim`, Vim, VS Code, or another editor for `/mechedit` external editing
- optional speech tools for `/mechvoice`: a recorder (`sox`/`rec`, `parecord`, `ffmpeg`, or `arecord`) and a local STT backend such as `whisper.cpp`, OpenAI Whisper CLI, Vosk, or a custom `MECHPI_STT_COMMAND`

On Ubuntu/Debian, typical packages are:

```bash
sudo apt install python3 python3-venv latexmk texlive-latex-base texlive-latex-extra poppler-utils
```

Your manuscript may require additional TeX Live packages depending on its preamble.

Optional editor/clipboard packages on Ubuntu/Debian:

```bash
sudo apt install neovim wl-clipboard xclip xsel
sudo apt install sox pulseaudio-utils ffmpeg alsa-utils
```

Useful editor environment variables:

```bash
export MECHPI_EDITOR=nvim
export MECHPI_EDITOR_TERMINAL=kitty
```

`/mechedit` also respects `VISUAL` and `EDITOR` when `MECHPI_EDITOR` is unset.
