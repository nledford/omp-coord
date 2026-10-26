#!/usr/bin/env bash
# Renders what a tmux pane shows, colours included, to a PNG for the docs.
#
#   scripts/screenshot.sh <tmux-target> <out.png> [first-line [last-line]]
#
# Needs tmux, freeze (brew install charmbracelet/tap/freeze), resvg (brew install resvg) and the JetBrains Mono Nerd
# Font (brew install --cask font-jetbrains-mono-nerd-font) for omp's status-line icons. Every form of the machine's
# name becomes "demo-mac", the home folder "~" and the user name "demo"; still look at the image before committing it.
# Lines are 1-based and inclusive; by default the whole visible pane is rendered.
set -euo pipefail

target=${1:?usage: screenshot.sh <tmux-target> <out.png> [first-line [last-line]]}
out=${2:?usage: screenshot.sh <tmux-target> <out.png> [first-line [last-line]]}
first=${3:-1}
last=${4:-\$}
font="$HOME/Library/Fonts/JetBrainsMonoNerdFontMono-Regular.ttf"

for tool in tmux freeze resvg; do
  command -v "$tool" >/dev/null || { echo "screenshot.sh: $tool is not installed (see the header of this script)" >&2; exit 1; }
done
[ -f "$font" ] || { echo "screenshot.sh: $font is missing: brew install --cask font-jetbrains-mono-nerd-font" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# One sed expression per non-empty value, longest first (so "name.local" goes before "name"), with regex characters
# escaped.
redactions=()
add() {
  local value=$1 replacement=$2
  [ -n "$value" ] || return 0
  redactions+=(-e "s/$(printf '%s' "$value" | sed 's/[][\.*^$/]/\\&/g')/$replacement/g")
}
add "$HOME" "~"
while IFS= read -r name; do add "$name" demo-mac; done < <(
  { hostname; hostname -s; scutil --get ComputerName; scutil --get LocalHostName; } 2>/dev/null |
    awk 'NF && !seen[$0]++ { print length($0) "\t" $0 }' | sort -rn | cut -f2-
)
add "$(id -un)" demo

tmux capture-pane -e -p -t "$target" |
  sed -n "${first},${last}p" |
  sed "${redactions[@]}" >"$work/pane.ansi"

# freeze's own PNG output drops fonts it embeds, so it writes an SVG naming the font and resvg draws it.
freeze "$work/pane.ansi" --language ansi --output "$work/pane.svg" \
  --window --padding 20 --margin 0 --border.radius 8 --shadow.blur 0 \
  --font.family "JetBrainsMono NFM" --font.size 14 --line-height 1.3 >/dev/null
resvg --use-font-file "$font" --font-family "JetBrainsMono NFM" --zoom 2 "$work/pane.svg" "$out" 2>/dev/null
echo "wrote $out"
