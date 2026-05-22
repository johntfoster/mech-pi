# mech-pi

`mech-pi` is a pi extension package for mechanics-aware LaTeX paper development. It treats the paper repository as the source of truth and gives the agent tools for ingestion, equation focus, compilation, PDF preview, and lightweight mechanics checks.

## Install locally

From any paper repo:

```bash
pi install /home/jfoster/Documents/mech-pi
# or for one run only
pi -e /home/jfoster/Documents/mech-pi
```

Then reload pi or start a new pi session in your LaTeX repository.

## Core idea

The `.tex` files win over stale chat context. `mech-pi` injects research-mode instructions into pi and exposes tools that keep the assistant grounded in the current files:

- `mech_ingest` builds `.mechpi/paper-map.json` from `main.tex`, included files, macros, labels, equations, citations, bibliography keys, and TODOs.
- `mech_focus_equation` locates one equation by label or content and returns exact LaTeX source, nearby context, symbols/macros, and simple index red flags.
- `mech_compile` runs `latexmk -pdf` and summarizes errors/warnings.
- `mech_preview_pdf` opens the compiled PDF with `MECHPI_PDF_VIEWER` or `xdg-open`.
- `mech_search_symbol` searches all ingested TeX files.
- `mech_check` runs lightweight LaTeX/reference/index checks and mechanics prompts.

## Slash commands

```text
/mechmap [root.tex]       ingest and cache the paper map
/mechcompile             run latexmk on the detected root
/mechpreview             open root PDF
/mechquestions [topic]   ask pi to interrogate the development
```

## Example prompts

```text
ingest the paper and show me the theory map
focus equation eq:local-entropy-inequality and challenge it
find all uses of \rho_\alpha and tell me if notation drifts
compile, summarize errors, and fix the first LaTeX issue
ask me skeptical mixture-theory questions about the mass transfer terms
review section 3 like a thermodynamics referee
```

## PDF preview

Set a preferred viewer if desired:

```bash
export MECHPI_PDF_VIEWER=zathura
```

Otherwise `mech_preview_pdf` uses `xdg-open`.

## Status

This is a morning-demo MVP. It is intentionally lightweight and repo-local. Next planned layers:

1. richer symbol/notation registry,
2. dimensions database checks,
3. phase-index conservation checks,
4. SymPy sandbox for scalar/free-energy derivations,
5. custom TUI equation browser,
6. reviewer/interrogation workflows with persistent paper-state summaries.
