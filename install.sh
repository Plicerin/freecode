#!/usr/bin/env bash
# freecode installer (macOS/Linux).
#   From a clone or anywhere:  ./install.sh --honcho http://<host>:8100
# Installs the PUBLISHED npm package globally (runs on plain Node — no Bun, no
# clone to maintain), and REMOVES any old auto-updating source launcher that used
# to shadow it. After this, `freecode` in any folder is exactly what you
# installed; update later with `freecode update`.
set -euo pipefail

HONCHO_URL="${FREECODE_HONCHO_URL:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --honcho)  HONCHO_URL="$2"; shift 2 ;;
    -h|--help) echo "usage: ./install.sh [--honcho <url>]"; exit 0 ;;
    *)         echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

echo "== freecode installer =="

# --- Node / npm ---
if ! command -v npm >/dev/null 2>&1; then
  echo "npm (Node.js) not found. Install Node 18+ from https://nodejs.org (or your package manager), then re-run." >&2
  exit 1
fi
echo "node $(node --version)  npm $(npm --version)"

# --- Install the published package globally ---
echo "Installing @vrocket/freecode (global) ..."
npm install -g "@vrocket/freecode@latest"
echo "Installed. 'freecode' is on your PATH."

# --- Remove the OLD auto-updating source launcher (it shadowed the npm install) ---
for RC in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  [ -f "$RC" ] || continue
  if grep -q ">>> freecode launcher" "$RC" 2>/dev/null; then
    if command -v perl >/dev/null 2>&1; then
      perl -0777 -i -pe 's/# >>> freecode launcher.*?# <<< freecode launcher[^\n]*\n?//s' "$RC" 2>/dev/null || true
    else
      # perl absent: drop the marked block with awk (skip between the fences).
      awk 'BEGIN{skip=0} /# >>> freecode launcher/{skip=1} skip==0{print} /# <<< freecode launcher/{skip=0}' "$RC" > "$RC.tmp" && mv "$RC.tmp" "$RC"
    fi
    echo "Removed the old 'freecode' launcher from $RC (it shadowed the npm install). Open a new shell."
  fi
done

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

echo
echo "Done. Open a NEW shell, then from any folder:  freecode"
echo "Update later with:  freecode update   (or: npm i -g @vrocket/freecode@latest)"
echo "Add a model: set ANTHROPIC_API_KEY (etc.), or use /provider in the REPL."
