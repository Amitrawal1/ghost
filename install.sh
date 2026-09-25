#!/usr/bin/env bash
# Ghost Assistant installer for macOS. Run it with:
#   curl -fsSL https://raw.githubusercontent.com/Amitrawal1/ghost/main/install.sh | bash
#
# What it does, all inside ~/.ghost (no sudo, nothing system-wide):
#   1. uses your Node.js 20+ if you have it, otherwise downloads a private copy (checksum verified)
#   2. downloads Ghost and installs Electron
#   3. adds the `ghost` command to your shell
#   4. runs `ghost setup` (API key, profile, resume) unless you already did it
# Running it again updates Ghost and keeps your settings.
set -euo pipefail

REPO="${GHOST_REPO:-Amitrawal1/ghost}"
BRANCH="${GHOST_BRANCH:-main}"
GHOST_HOME="${GHOST_HOME:-$HOME/.ghost}"
APP="$GHOST_HOME/app"
BIN="$GHOST_HOME/bin"
NODE_LINE=24

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\033[36m→\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS. On Windows, use the PowerShell command in the README."
ARCH="$(uname -m)"
# A Terminal running under Rosetta reports x86_64 on Apple Silicon.
[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ] && ARCH=arm64
case "$ARCH" in arm64) ;; x86_64) ARCH=x64 ;; *) fail "Unsupported processor: $ARCH" ;; esac

echo
bold "👻 Installing Ghost Assistant (macOS, $ARCH)"
mkdir -p "$GHOST_HOME"

# 1. Node.js
NODE=""
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 20 ] 2>/dev/null && NODE="$(command -v node)"
fi
if [ -z "$NODE" ] && [ -x "$GHOST_HOME/node/bin/node" ]; then NODE="$GHOST_HOME/node/bin/node"; fi
if [ -z "$NODE" ]; then
  step "Downloading Node.js (a private copy just for Ghost)…"
  base="https://nodejs.org/dist/latest-v$NODE_LINE.x"
  line="$(curl -fsSL "$base/SHASUMS256.txt" | grep " node-v[0-9.]*-darwin-$ARCH.tar.gz\$" | head -1)"
  [ -n "$line" ] || fail "Could not find a Node.js download. Check your internet and try again."
  sum="${line%% *}"
  file="${line##* }"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  [ "$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)" = "$sum" ] || fail "The Node.js download was corrupted. Try again."
  rm -rf "$GHOST_HOME/node" && mkdir -p "$GHOST_HOME/node"
  tar -xzf "$tmp/$file" --strip-components=1 -C "$GHOST_HOME/node"
  rm -rf "$tmp"
  NODE="$GHOST_HOME/node/bin/node"
fi
NODE_DIR="$(cd "$(dirname "$NODE")" && pwd)"
export PATH="$NODE_DIR:$PATH"
step "Using Node.js $("$NODE" -v)"

# 2. Ghost itself. Unpacking over the old copy keeps node_modules, so updates are quick.
step "Downloading Ghost…"
mkdir -p "$APP"
if [ -n "${GHOST_SOURCE:-}" ]; then
  # Local folder instead of GitHub, for testing this installer.
  (cd "$GHOST_SOURCE" && tar -cf - --exclude node_modules --exclude dist --exclude .git .) | tar -xf - -C "$APP"
else
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz --strip-components=1 -C "$APP"
fi
step "Installing Electron (about 150 MB the first time, a minute or two)…"
(cd "$APP" && npm install --no-audit --no-fund --loglevel=error) || fail "npm install failed. Check your internet and run the installer again."
# Electron 44+ fetches its binary on first use; do it now so the first `ghost` starts right away.
(cd "$APP" && "$NODE" -e "require('electron')" >/dev/null) || fail "Could not download Electron. Check your internet and run the installer again."

# 3. The `ghost` command
mkdir -p "$BIN"
cat > "$BIN/ghost" <<EOF
#!/bin/sh
export PATH="$NODE_DIR:\$PATH"
exec "$NODE" "$APP/bin/ghost.js" "\$@"
EOF
chmod +x "$BIN/ghost"
for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
  [ "$rc" = "$HOME/.zshrc" ] || [ -f "$rc" ] || continue
  if ! grep -qs "$BIN" "$rc"; then
    printf '\n# Ghost Assistant\nexport PATH="%s:$PATH"\n' "$BIN" >> "$rc"
  fi
done
step "Added the ghost command"

# 4. Setup wizard. The installer's own stdin is the curl pipe, so read answers from the terminal.
if (exec < /dev/tty) 2>/dev/null; then
  "$BIN/ghost" setup --if-needed < /dev/tty || true
  echo
  printf 'Start Ghost now? [Y/n] '
  read -r answer < /dev/tty || answer=n
  case "$answer" in [nN]*) ;; *) "$BIN/ghost" ;; esac
fi

echo
bold "Done! From now on, open a new Terminal window and type:  ghost"
echo "   ghost setup    change your API key, profile or resume"
echo "   ghost update   get the latest version"
