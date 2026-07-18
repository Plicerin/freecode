#!/usr/bin/env bash
# freecode setup for a fresh macOS/Linux machine.
#   1. clone this repo, then from inside it:  ./setup.sh --honcho http://<host>:8100
#   2. or without memory:                     ./setup.sh
# Does: prereq check (installs Bun if missing) -> checkout the branch -> bun install
# -> optionally write ~/.freecode/settings.json with the shared-memory endpoint
# -> typecheck. Non-destructive: never overwrites an existing settings.json.
set -euo pipefail

BRANCH="${BRANCH:-feat/tier-a-parity}"
HONCHO_URL="${FREECODE_HONCHO_URL:-}"   # optional; enables cross-machine memory
SKIP_CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --honcho)     HONCHO_URL="$2"; shift 2 ;;
    --branch)     BRANCH="$2"; shift 2 ;;
    --skip-check) SKIP_CHECK=1; shift ;;
    -h|--help)    echo "usage: ./setup.sh [--honcho <url>] [--branch <name>] [--skip-check]"; exit 0 ;;
    *)            echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
cd "$(dirname "$0")"  # run from the repo root (this script lives there)

echo "== freecode setup =="
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun not found - installing from bun.sh ..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || { echo "Bun installed but not on PATH - open a new shell and re-run ./setup.sh"; exit 1; }
fi
echo "bun $(bun --version)"

# Best-effort branch sync (the repo is already cloned). If git is absent or the
# sync fails, warn and continue - bun install + settings still work.
if command -v git >/dev/null 2>&1; then
  echo "Syncing to branch '$BRANCH' ..."
  git fetch -q origin && git checkout "$BRANCH" && git pull --ff-only \
    || echo "git sync skipped - continuing on the current checkout (ensure you're on '$BRANCH')."
else
  echo "git not on PATH - skipping branch sync (ensure you're on '$BRANCH')."
fi

echo "Installing deps (bun install) ..."
bun install

APP_DIR="$HOME/.freecode"
mkdir -p "$APP_DIR"
SETTINGS="$APP_DIR/settings.json"

if [ -n "$HONCHO_URL" ]; then
  if [ -f "$SETTINGS" ]; then
    echo "settings.json already exists - not touching it. To enable shared memory, add:"
    echo "  \"memory\": { \"provider\":\"honcho\", \"enabled\":true, \"baseUrl\":\"$HONCHO_URL\", \"workspace\":\"freecode\", \"peer\":\"user\" }"
  else
    cat > "$SETTINGS" <<JSON
{
  "memory": { "provider": "honcho", "enabled": true, "baseUrl": "$HONCHO_URL", "workspace": "freecode", "peer": "user" }
}
JSON
    echo "Wrote $SETTINGS  (memory -> $HONCHO_URL)"
  fi
  if curl -fsS "$HONCHO_URL/health" >/dev/null 2>&1; then
    echo "Honcho reachable at $HONCHO_URL"
  else
    echo "Honcho NOT reachable at $HONCHO_URL - is Tailscale up? (memory is fail-soft; freecode still runs without it)"
  fi
else
  echo "No --honcho URL -> shared memory not configured."
  echo "Enable later:  ./setup.sh --honcho http://<honcho-host>:8100"
fi

[ "$SKIP_CHECK" = "1" ] || { echo "Typechecking ..."; bun run typecheck; }

echo
echo "Done. Launch freecode:"
echo "  bun run src/cli.tsx"
echo "Add a model: set ANTHROPIC_API_KEY (or OPENAI_API_KEY ...), or run the REPL and use /provider."
echo "On Tailscale? freecode auto-discovers your remote ollama/llama-server."
