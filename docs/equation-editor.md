# Equation editor and rendered preview

`/mecheqedit` and `mech_focus_equation` with `edit: true` open an equation-only editing panel.

## What appears

1. A top preview panel.
   - `mech-pi` creates a small standalone LaTeX document.
   - It reuses the manuscript root preamble so project macros such as `\mbf` and `\bs` work.
   - It compiles with `pdflatex`.
   - It converts the output PDF to PNG with `pdftoppm`.
   - pi displays the PNG inline if the terminal supports image rendering.
2. A lower source editor containing the exact equation environment from the manuscript.
3. On save, the source block is replaced in-place and `.mechpi/paper-map.json` is rebuilt.

## Basic usage

```text
/mecheqedit eq:mom_gas
```

or ask naturally:

```text
Focus on eq:mom_gas in edit mode
```

## Editing keys

The editor uses pi's standard extension editor:

- Enter: submit/save
- Shift+Enter: insert a newline
- Esc or Ctrl+C: cancel
- configured external-editor shortcut: open `$VISUAL` or `$EDITOR`

For vim/nvim as the external editor, set one of:

```bash
export VISUAL=nvim
export EDITOR=nvim
```

Start pi after setting the variable.

## Render artifacts

Temporary render files are created under:

```text
.mechpi/equation-render/
```

Temporary directories are removed after successful rendering. If rendering fails, the panel falls back to source text and shows the LaTeX error tail.

## Why not KaTeX?

KaTeX is fast and useful for browser previews, but it does not understand arbitrary manuscript macros and packages. `mech-pi` uses the paper's actual LaTeX preamble so the preview matches the manuscript more faithfully.
