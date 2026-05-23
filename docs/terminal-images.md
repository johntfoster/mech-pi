# Terminal image settings

The equation editor and rendered LaTeX previews can show compiled PNG images directly in the terminal, but inline image rendering depends on the local terminal and terminal multiplexers.

## Supported terminal setups

Inline images are most reliable with:

- Kitty
- Ghostty
- WezTerm
- iTerm2

Many terminals do not support inline PNG protocols, including many default Linux terminal emulators and macOS Terminal.app.

## SSH

Inline images can work over SSH if the local terminal supports the image protocol and escape sequences are passed through unchanged.

The PNG is rendered on the remote machine where pi runs. pi sends terminal image escape sequences back through SSH to your local terminal. Kitty graphics receive raster image payloads; SVG may be used as an intermediate in other tools, but `mech-pi` displays high-resolution PNGs for compatibility.

## Kitty without tmux

First test outside tmux:

```bash
kitty +kitten icat /path/to/image.png
```

If this works outside pi, the terminal side is capable.

## Kitty with tmux

Modern tmux versions can pass through image escape sequences. Check your version:

```bash
tmux -V
```

`allow-passthrough` is available in newer tmux versions, roughly tmux 3.3 and later.

Add to `~/.tmux.conf`:

```tmux
set -g allow-passthrough on
set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm-kitty:RGB"
```

Reload tmux config:

```bash
tmux source-file ~/.tmux.conf
```

Then fully restart tmux if needed:

```bash
tmux kill-server
```

Start a new tmux session and test:

```bash
kitty +kitten icat /path/to/image.png
```

If `tmux source-file` reports that `allow-passthrough` is not an option, your tmux is too old. Upgrade tmux or run pi outside tmux for inline equation previews.

## Troubleshooting checklist

1. Test `kitty +kitten icat image.png` outside tmux.
2. Test the same command inside tmux.
3. If outside works but inside fails, tmux passthrough is the blocker.
4. Upgrade tmux if `allow-passthrough` is unavailable.
5. Try pi outside tmux to confirm `mech-pi` rendering itself works.

## Full-screen copy mode and images

When running outside tmux, `Ctrl-a` then `]` opens `mech-pi`'s full-screen copy mode over the rendered TUI. Inline equation images are represented by a single centered `[latex_image.png]` placeholder in copy mode, while hidden metadata tracks the LaTeX source and PNG payload across the image's occupied rows.

In full-screen `VISUAL LINE` mode:

- `y` over an equation image yanks the underlying LaTeX source and returns to the prompt in `NORMAL` mode.
- `Y` over an equation image copies the PNG image itself when `wl-copy` or `xclip` supports image clipboard writes, then returns to the prompt in `NORMAL` mode.

## Overlay behavior

Kitty graphics are separate terminal image placements, not ordinary text cells. Before opening preview popups such as `/mecheqedit` and `/mechciteedit`, `mech-pi` deletes visible Kitty images and temporarily suppresses assistant inline LaTeX previews so stale images do not appear above the editor popup. The popup is cleared again on close so the normal chat view can redraw cleanly.

Extension popups render their full width with the theme's popup background. This is intentionally opaque: true terminal alpha is not portable, and transparent spaces made underlying model/status text bleed through dialogs.

## Fallback behavior

If inline rendering is not possible, the equation editor falls back to source text and reports rendering errors when LaTeX compilation fails. The manuscript source editing still works.
