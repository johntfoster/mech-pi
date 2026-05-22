# Tools and commands

## Slash commands

### `/mechmap [root.tex]`

Ingest the current LaTeX repository and write `.mechpi/paper-map.json`.

### `/mecheqedit eq:label`

Open a focused equation editor for a labeled equation. The top panel shows a compiled/typeset preview when terminal image display is available. The lower panel edits the exact LaTeX source block. Saving replaces the equation block in the manuscript and rebuilds `.mechpi/paper-map.json`.

Example:

```text
/mecheqedit eq:mom_gas
```

### `/mecheqedit contains:fragment`

Open the first equation whose source contains `fragment`.

Example:

```text
/mecheqedit contains:\rho_g\mbf{a}_g
```

### `/mechcompile`

Run `latexmk -pdf -interaction=nonstopmode` on the detected root TeX file.

### `/mechpreview`

Open the compiled root PDF using `MECHPI_PDF_VIEWER` or `xdg-open`.

### `/mechquestions [topic]`

Ask pi to interrogate the mechanics development around a topic.

## Agent tools

These are callable by the model during normal conversation.

### `mech_ingest`

Builds the paper map from TeX sources and bibliography files.

Parameters:

- `root?: string` — root TeX file, otherwise auto-detects `main.tex` or a file with `\documentclass`.
- `writeCache?: boolean` — write `.mechpi/paper-map.json`; defaults to true.

### `mech_focus_equation`

Locates one equation by label or contents and returns source, context, symbols, and index warnings.

Parameters:

- `label?: string`
- `contains?: string`
- `contextLines?: number`
- `edit?: boolean` — when true, opens the interactive equation editor.

### `mech_search_symbol`

Searches all ingested TeX files for a macro, symbol, or text fragment.

### `mech_check`

Runs lightweight checks for references, citations, duplicate labels, TODOs, and simple index red flags.

### `mech_compile`

Runs latexmk and summarizes errors/warnings.

### `mech_preview_pdf`

Opens the compiled PDF.
