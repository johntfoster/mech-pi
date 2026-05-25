# Prompt and copy-mode keybindings

`mech-pi` replaces pi's default prompt editor with a vim-style modal prompt editor plus a tmux-like full-screen copy mode.

## Prompt modes

The prompt shows only the current mode on the lower border: `INSERT`, `NORMAL`, `VISUAL`, `VISUAL LINE`, or `PREFIX`.

### INSERT mode

Default typing mode. After commands, dialogs, and assistant responses return focus to the prompt, the prompt re-enters `INSERT` mode. The exception is full-screen copy mode, which returns to `NORMAL` mode so `p`/`P` paste is immediately available.

- `Enter`: send the prompt
- `Shift-Enter`: insert a newline
- `Backspace`: delete one character before the cursor
- `Esc`: switch to `NORMAL`
- `Ctrl-s`: send the prompt
- `Up` / `Down`: cycle persistent prompt history; if text is already typed, only prompts with that prefix are shown, e.g. `/mechaddcite` filters to previous `/mechaddcite...` prompts
- In mech-pi fuzzy completions (`/mechedit`, `/mecheqedit`, `/mechciteedit`, `/mechgotocite`, `/mechingest`), matches appear below the prompt with the best match highlighted; `Tab`/`Down` and `Shift-Tab`/`Up` move the highlight, and `Enter` accepts the highlighted match and sends the command.
- optional push-to-talk: set `MECHPI_VOICE_SPACE_HOLD=1`, then hold `Space` on an empty prompt; release `Space` to stop after a short grace period
- `Ctrl-a`: start a tmux-like prefix; the next key must arrive within 2 seconds
- `Ctrl-a` then `c`: create pane 2, pane 3, etc. after the current session/pane 1
- `Ctrl-a` then `n` / `p`: switch to next/previous mech-pi logical pane
- `Ctrl-a` then `1` ... `9`: jump directly to that numbered mech-pi logical pane
- `Ctrl-a` then `]`: enter full-screen copy mode

### NORMAL mode

Vim-style prompt editing.

- `Enter` or `Ctrl-s`: send the prompt
- `i`, `a`, `I`, `A`, `o`, `O`: enter `INSERT`
- `h`, `j`, `k`, `l`: move
- `Up` / `Down`: browse persistent prompt history, prefix-filtered by the current prompt text
- `Left` / `Right`: move
- `w`, `e`, `b`, `ge`: word movement
- `gg`, `G`: start/end of prompt buffer
- `0`, `^`, `$`: line start/first nonblank/line end
- `J`: join current line with the next line
- `v`: enter prompt `VISUAL` character selection
- `V`: enter prompt `VISUAL LINE` selection
- `x`, `X`, `D`, `dd`: delete character/backward character/to end of line/line
- `C`, `cc`, `S`: change to end of line/line
- `yy`: yank current line
- `p`, `P`: paste after/before
- `u`: undo
- `Ctrl-a`: start a tmux-like prefix; the next key must arrive within 2 seconds
- `Ctrl-a` then `c`: create pane 2, pane 3, etc. after the current session/pane 1
- `Ctrl-a` then `n` / `p`: switch to next/previous mech-pi logical pane
- `Ctrl-a` then `1` ... `9`: jump directly to that numbered mech-pi logical pane
- `Ctrl-a` then `]`: enter full-screen copy mode

### VISUAL / VISUAL LINE mode in the prompt

Visual mode selects text inside the prompt editor. `v` selects by character; `V` selects whole lines.

- `h`, `j`, `k`, `l` or arrow keys: extend selection
- `w`, `e`, `b`, `ge`: word movement
- `gg`, `G`: start/end of prompt buffer
- `PageUp`, `PageDown`, `Ctrl-b`, `Ctrl-f`: page movement
- `0`, `^`, `$`: line movement
- `y`: copy selection
- `d` or `x`: cut selection
- `c` or `s`: cut selection and enter `INSERT`
- `p` or `P`: replace selection with the yank/clipboard text
- `Esc` or `v`: return to `NORMAL`
- `V`: toggle linewise visual selection

Yanks are also sent to the system clipboard when `wl-copy`, `xclip`, or `xsel` is available.

## Modal popup editors

`/mechingest` uses foreground drill-down popup layers for source confirmation: `l` or `Enter` accepts/drills into the highlighted choice, while `h`, `q`, or `Esc` backs out to the previous layer.

`/mecheqedit`, `/mechciteedit`, and `/mechedit --inline` use the same modal editing core as the prompt. Popup editors open in normal mode when pre-filled with existing text and in insert mode only when the editor buffer starts empty. Popup editors add source line numbers in the gutter when the buffer maps to a manuscript or bibliography file, use LaTeX/BibTeX-aware syntax highlighting, and provide fuzzy `Tab` dropdown completions for LaTeX commands, paper labels/refs, BibTeX cite keys, environments, and equation symbols where relevant. In command mode, `:<line>` jumps to the displayed source line; `:w` writes/refreshes when available; `:wq`, `:x`, or `Ctrl-s` save and close; `Ctrl-c` or `:q` cancel.

## Voice input

- `/mechvoice start`: start recording from the default microphone
- `/mechvoice stop`: stop recording and insert the transcript
- `/mechvoice toggle`: toggle recording
- `Ctrl+Alt+Space`: toggle voice recording
- Optional: set `MECHPI_VOICE_SPACE_HOLD=1`, then hold `Space` for `MECHPI_VOICE_HOLD_MS` on an empty prompt to push-to-talk. This depends on terminal key-release support.

See `docs/tools-and-commands.md` for STT backend environment variables.

## Tmux-like full-screen copy mode

Use `Ctrl-a` then `]` from the prompt to leave the prompt and enter a full-screen copy/navigation mode over the current rendered pi screen. This is intended as a tmux-copy-mode replacement when running `mech-pi` directly in Kitty/Ghostty/WezTerm/iTerm2 for terminal image support.

The key sequence is prefix-style: press `Ctrl-a`, release it, then press the command key within 2 seconds. If your terminal batches the keys as `Ctrl-a]`, `Ctrl-a c`, `Ctrl-a n`, or similar, that is also handled. If you keep holding Ctrl and send `Ctrl-]`, that is handled too.

Prompt prefix commands are `c` for a new mech-pi logical pane, `n`/`p` for next/previous pane, `1`...`9` for direct pane selection, and `]` for full-screen copy mode. Logical panes are backed by pi session files and are switched in-place rather than drawn as simultaneous splits.

### COPY mode

- `j`, `k` or arrows: move down/up
- `h`, `l` or arrows: move left/right by character
- `PageUp`, `PageDown`, `Ctrl-b`, `Ctrl-f`: page through the rendered screen
- `w`, `e`, `b`, `ge`: word movement
- `gg`, `G`: first/last screen line
- `0`, `^`, `$`: beginning/first nonblank/end of current line
- `v`: enter/leave full-screen `VISUAL` character selection
- `V`: enter/leave full-screen `VISUAL LINE` selection
- `yy` or `Y`: copy current line and immediately return to the prompt in `NORMAL` mode
- `p` or `P`: paste the current yank/system clipboard into the prompt and return to the prompt in `NORMAL` mode
- `Ctrl-a` then `[`: return to the prompt in `NORMAL` mode
- `Esc` or `q`: return to the prompt in `NORMAL` mode

COPY mode highlights only the cursor character. Full-screen VISUAL mode highlights the selected text range.

### Full-screen VISUAL / VISUAL LINE mode

- Movement keys extend the selection
- `w`, `e`, `b`, `ge`, `gg`, `G`, `0`, `^`, `$`, page keys: same movement as COPY mode
- `y`: copy selection and immediately return to the prompt in `NORMAL` mode
- In `VISUAL LINE`, if the selection touches an inline rendered equation image, `y` copies the underlying LaTeX source for that image and returns to the prompt in `NORMAL` mode.
- In `VISUAL LINE`, if the selection touches an inline rendered equation image, `Y` copies the image PNG itself when `wl-copy` or `xclip` supports image clipboard writes, then returns to the prompt in `NORMAL` mode.
- Image placeholders are shown once as centered `[latex_image.png]` text within the image's occupied rows, rather than repeated on every image row.
- `p` or `P`: paste the copied/system clipboard text into the prompt and return to the prompt in `NORMAL` mode
- `v`: leave character visual selection
- `V`: leave/toggle line visual selection
- `Ctrl-a` then `[`, `Esc`, or `q`: return to the prompt

## Notes

- Full-screen copy mode works on a snapshot of the rendered TUI screen, not the raw session JSON.
- Terminal images and other non-text escape sequences are stripped from copied text.
- Inline equation-image metadata is tracked separately so VISUAL LINE selections can yank the source or PNG even though copied text contains only the centered placeholder.
- Clipboard integration uses `wl-copy`/`wl-paste`, `xclip`, or `xsel` when available; otherwise yanks still work inside `mech-pi` for the current session.
- Text yanks return to the prompt in `NORMAL` mode and populate the prompt yank buffer; use `p`/`P` there to paste.
