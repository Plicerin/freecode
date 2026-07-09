#!/usr/bin/env bash
# freecode one-command installer (macOS/Linux).
#   From inside a clone:  ./install.sh --honcho http://<host>:8100
# Installs Bun if missing, syncs this branch, bun install, writes
# ~/.freecode/settings.json (shared memory), and installs an AUTO-UPDATING
# `freecode` launcher into your shell rc. After this, just type `freecode` in any
# folder - it fast-forwards to the latest (at most hourly) and runs from source.
# Set FREECODE_NO_UPDATE=1 to skip the update check for a launch.
set -euo pipefail

BRANCH="${BRANCH:-feat/tier-a-parity}"
HONCHO_URL="${FREECODE_HONCHO_URL:-}"
NO_UPDATE_HOOK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --honcho)          HONCHO_URL="$2"; shift 2 ;;
    --branch)          BRANCH="$2"; shift 2 ;;
    --no-update-hook)  NO_UPDATE_HOOK=1; shift ;;
    -h|--help)         echo "usage: ./install.sh [--honcho <url>] [--branch <name>] [--no-update-hook]"; exit 0 ;;
    *)                 echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO"

echo "== freecode installer =="
echo "repo: $REPO"

# --- Bun ---
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun not found - installing from bun.sh ..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || { echo "Bun installed but not on PATH - open a new shell and re-run ./install.sh"; exit 1; }
fi
echo "bun $(bun --version)"

# --- Sync branch (best-effort) ---
if command -v git >/dev/null 2>&1; then
  echo "Syncing to branch '$BRANCH' ..."
  git fetch -q origin && git checkout "$BRANCH" && git pull --ff-only || echo "git sync skipped - continuing on current checkout."
else
  echo "git not on PATH - skipping branch sync (ensure you're on '$BRANCH')."
fi

# --- Deps ---
echo "Installing deps (bun install) ..."
bun install

# --- Shared memory config (non-destructive) ---
APP_DIR="$HOME/.freecode"
mkdir -p "$APP_DIR"
SETTINGS="$APP_DIR/settings.json"
if [ -n "$HONCHO_URL" ]; then
  if [ -f "$SETTINGS" ]; then
    echo "settings.json already exists - leaving it. To enable shared memory add a \"memory\" block with baseUrl=$HONCHO_URL."
  else
    cat > "$SETTINGS" <<JSON
{
  "memory": { "provider": "honcho", "enabled": true, "baseUrl": "$HONCHO_URL", "workspace": "freecode", "peer": "user" }
}
JSON
    echo "Wrote $SETTINGS  (memory -> $HONCHO_URL)"
  fi
fi

# --- Auto-updating launcher into the shell rc ---
RC="$HOME/.bashrc"; [ -n "${ZSH_VERSION:-}" ] && RC="$HOME/.zshrc"
[ -f "$HOME/.zshrc" ] && [ ! -f "$HOME/.bashrc" ] && RC="$HOME/.zshrc"
touch "$RC"

if [ "$NO_UPDATE_HOOK" = "1" ]; then
  read -r -d '' LAUNCHER <<EOF || true
# >>> freecode launcher (auto-updating) >>>
freecode() { bun run "$REPO/src/cli.tsx" "\$@"; }
# <<< freecode launcher <<<
EOF
else
  read -r -d '' LAUNCHER <<EOF || true
# >>> freecode launcher (auto-updating) >>>
freecode() {
  local repo="$REPO"
  if [ -z "\${FREECODE_NO_UPDATE:-}" ] && command -v git >/dev/null 2>&1; then
    local stamp="\$HOME/.freecode/update-stamp"
    if [ ! -f "\$stamp" ] || find "\$stamp" -mmin +60 2>/dev/null | grep -q .; then
      ( cd "\$repo" && git pull --ff-only --quiet >/dev/null 2>&1 || true )
      mkdir -p "\$HOME/.freecode" && touch "\$stamp"
    fi
  fi
  bun run "\$repo/src/cli.tsx" "\$@"
}
# <<< freecode launcher <<<
EOF
fi

# Remove any prior block (idempotent), then append the fresh one.
python3 - "$RC" <<'PY' 2>/dev/null || perl -0777 -i -pe 's/# >>> freecode launcher.*?# <<< freecode launcher[^\n]*\n?//s' "$RC"
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r"# >>> freecode launcher.*?# <<< freecode launcher[^\n]*\n?", "", s, flags=re.S)
open(p, "w").write(s)
PY
printf '\n%s\n' "$LAUNCHER" >> "$RC"
echo "Installed the 'freecode' launcher -> $RC"

echo
echo "Done. Open a NEW terminal (or: source $RC), then from any folder:"
echo "  freecode"
echo "It auto-updates on launch (hourly, best-effort). Skip once with: FREECODE_NO_UPDATE=1 freecode"
echo "Add a model: set ANTHROPIC_API_KEY (etc.), or use /provider in the REPL."
