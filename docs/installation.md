# Installation

`mech-pi` is a pi package containing one extension, one mechanics-research skill, and prompt templates for source-grounded LaTeX paper development.

## Install from GitHub

After the repository is published:

```bash
pi install git:github.com/johntfoster/mech-pi
```

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

For LaTeX compilation and equation rendering, install:

- `latexmk` for `/mechcompile`
- `pdflatex` for equation preview rendering
- `pdftoppm` from poppler-utils for converting equation previews to PNG
- a terminal that supports inline images if you want rendered equation previews inside the TUI

On Ubuntu/Debian, typical packages are:

```bash
sudo apt install latexmk texlive-latex-base texlive-latex-extra poppler-utils
```

Your manuscript may require additional TeX Live packages depending on its preamble.
