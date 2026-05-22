# Terminal image settings

The equation editor can show a compiled PNG preview directly in the terminal, but inline image rendering depends on the local terminal and terminal multiplexers.

## Supported terminal setups

Inline images are most reliable with:

- Kitty
- Ghostty
- WezTerm
- iTerm2

Many terminals do not support inline PNG protocols, including many default Linux terminal emulators and macOS Terminal.app.

## SSH

Inline images can work over SSH if the local terminal supports the image protocol and escape sequences are passed through unchanged.

The PNG is rendered on the remote machine where pi runs. pi sends terminal image escape sequences back through SSH to your local terminal.

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

## Fallback behavior

If inline rendering is not possible, the equation editor falls back to source text and reports rendering errors when LaTeX compilation fails. The manuscript source editing still works.
