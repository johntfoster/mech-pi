# Equation editor and rendered preview

`/mecheqedit` and `mech_focus_equation` with `edit: true` open an equation-only editing panel. For broader manuscript edits, use `/mechedit query` to open an external editor at a likely source location, or `/mechedit --inline query` to open the integrated modal source editor.

## What appears

1. A top preview panel.
   - `mech-pi` creates a small standalone LaTeX document.
   - It reuses the manuscript root preamble so project macros such as `\mbf` and `\bs` work.
   - It compiles with `pdflatex`.
   - It converts the output PDF to PNG with `pdftoppm`.
   - pi displays the PNG inline if the terminal supports image rendering.
   - If `.aux` data gives the equation's original PDF number, the isolated preview injects a temporary `\tag{...}` so the preview shows that number without editing the manuscript source.
   - The image is generated at high DPI and terminal-scaled by the current terminal width to preserve aspect ratio.
2. A lower source editor containing the exact equation environment from the manuscript, with line numbers mapped back to the original source file and basic LaTeX highlighting.
3. On save, the source block is replaced in-place and `.mechpi/paper-map.json` is rebuilt.

## Basic usage

```text
/mecheqedit eq:mom_gas
/mecheqedit number:2.14
```

or ask naturally:

```text
Focus on eq:mom_gas in edit mode
```

## Editing keys

The editor uses an embedded vim-style editing mode consistent with the prompt editor. The lower status line shows `INSERT`, `NORMAL`, `VISUAL`, or `VISUAL LINE`.

Normal mode:

- `i`, `a`, `I`, `A`, `o`, `O`: enter insert mode
- `h`, `j`, `k`, `l` or arrow keys: move
- `J`: join current line with the next line
- `w`, `e`, `b`, `ge`: move by word start/end forward/backward
- `gg`, `G`: move to start/end of buffer
- `f<char>`, `F<char>`, `t<char>`, `T<char>`: move to/till next/previous character on the current line
- `;`, `,`: repeat the last character search forward/backward
- `/pattern`, `?pattern`: search forward/backward; `n`/`N` repeat same/opposite direction
- `0`, `^`, `$`: move to beginning/first nonblank/end of line
- `u`: undo
- `x`, `X`: delete character under/before cursor
- `r<char>`: replace character
- `dd`, `D`: delete line/delete to end of line
- `cc`, `S`, `C`: change line/change line/change to end of line
- `yy`, `p`, `P`: yank line/paste after/paste before
- `v`: enter `VISUAL` character selection
- `V`: enter `VISUAL LINE` selection
- `:`: enter command mode
- `Ctrl+C`: cancel the popup

Visual / visual-line mode:

- `h`, `j`, `k`, `l` or arrow keys: extend selection
- `w`, `e`, `b`, `gg`, `G`, `0`, `^`, `$`: move/extend selection
- `PageUp`, `PageDown`, `Ctrl-b`, `Ctrl-f`: page movement
- `y`: yank selection and return to normal mode
- `d` or `x`: delete selection and return to normal mode
- `c` or `s`: change selection and enter insert mode
- `p` or `P`: replace selection with the current yank
- `Esc` or `v`: return to normal mode
- `V`: toggle linewise selection

Insert mode:

- `Esc`: return to normal mode; it does **not** close the popup
- `Enter`: insert a newline
- `Ctrl+C`: cancel the popup

Command mode:

- `:<line>`: jump to a source line number shown in the gutter
- `:w`: re-render the preview from the current buffer and keep editing
- `:wq` or `:x`: accept the edit and save it back to the TeX source
- `:q` or `:q!`: close/cancel the popup
- `:s/pattern/replacement/`: replace on the current line
- `:s/pattern/replacement/g`: replace all matches on the current line
- `:%s/pattern/replacement/g`: replace all matches in the equation buffer

The preview is not currently re-rendered on every keystroke because rendering runs LaTeX, but `:w` provides an explicit refresh checkpoint. When the popup opens, `mech-pi` clears/suppresses existing assistant inline images so old Kitty image placements do not cover the editor. Number-based opening relies on compiled `.aux` files; when they are missing or stale, `mech-pi` attempts `latexmk` first and reports compilation errors if the number map cannot be refreshed.

LaTeX autocomplete is available in insert mode and uses the same fuzzy dropdown behavior as other mech-pi search locations. Backslash completions include common LaTeX commands and manuscript macros; `\ref{...}`/`\eqref{...}`/`\cref{...}` complete local labels; `\cite{...}`-style commands complete local BibTeX keys with title/author/year search text when available; `\begin{...}` and `\end{...}` complete environments; forced `Tab` completion can also surface symbols/macros seen in ingested equations.

## Relationship to `/mechedit`

Use `/mecheqedit` when you want the focused equation-only popup with preview and exact-block replacement. Use `/mechedit` when you want the surrounding manuscript prose, section, or arbitrary source location. By default `/mechedit` opens an external editor such as nvim or VS Code; `/mechedit --inline` opens the full source file in the same modal popup editor, with source line numbers and basic LaTeX/BibTeX highlighting.

## Render artifacts

Temporary render files are created under:

```text
.mechpi/equation-render/
```

Temporary directories are removed after successful rendering. If rendering fails, the panel falls back to source text and shows the LaTeX error tail.

Number preservation in the preview is a render-only transformation. The lower editor still contains the exact source block from the manuscript. Automatically numbered but unlabeled equations cannot be recovered from standard `.aux` number data; add a `\label` or explicit `\tag` if you need to open them by PDF number.

## Why not KaTeX?

KaTeX is fast and useful for browser previews, but it does not understand arbitrary manuscript macros and packages. `mech-pi` uses the paper's actual LaTeX preamble so the preview matches the manuscript more faithfully.
