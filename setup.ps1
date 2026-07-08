# freecode setup for a fresh Windows machine.
#   1. clone this repo, then from inside it:  ./setup.ps1 -HonchoUrl http://<host>:8100
#   2. or without memory:                      ./setup.ps1
# Does: prereq check (installs Bun if missing) -> checkout the branch -> bun install
# -> optionally write ~/.freecode/settings.json with the shared-memory endpoint
# -> typecheck. Non-destructive: never overwrites an existing settings.json.
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a BOM-less script
# as ANSI, so a stray "curly" char (em-dash, check mark) corrupts the parse.
param(
  [string]$Branch = "feat/tier-a-parity",
  [string]$HonchoUrl = $env:FREECODE_HONCHO_URL,  # optional; enables cross-machine memory
  [switch]$SkipCheck
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot  # run from the repo root (this script lives there)

function Have($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }

Info "== freecode setup =="

if (-not (Have bun)) {
  Warn "Bun not found - installing from bun.sh ..."
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  $env:Path = "$HOME\.bun\bin;$env:Path"
  if (-not (Have bun)) { throw "Bun installed but not on PATH. Open a new terminal and re-run ./setup.ps1" }
}
Ok ("bun " + (bun --version))

# Best-effort sync to the right branch + latest. The repo is ALREADY cloned, so
# if git isn't usable in THIS shell (common: you cloned in Git Bash and git isn't
# on PowerShell's PATH), just warn and carry on - bun install + settings still
# work on whatever you have checked out.
if (Have git) {
  Info "Syncing to branch '$Branch' ..."
  try {
    git fetch --quiet origin
    git checkout $Branch
    git pull --ff-only
  } catch {
    Warn "git sync skipped ($($_.Exception.Message)). Continuing on the current checkout - make sure you're on '$Branch'."
  }
} else {
  Warn "git not on PATH here - skipping branch sync. Ensure you're on '$Branch' (add Git's cmd dir to PATH, or use Git Bash, to sync)."
}

Info "Installing deps (bun install) ..."
bun install

$appDir = Join-Path $HOME ".freecode"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
$settingsPath = Join-Path $appDir "settings.json"

if ($HonchoUrl) {
  if (Test-Path $settingsPath) {
    Warn "settings.json already exists - not touching it. To enable shared memory, add:"
    Warn "  `"memory`": { `"provider`":`"honcho`", `"enabled`":true, `"baseUrl`":`"$HonchoUrl`", `"workspace`":`"freecode`", `"peer`":`"user`" }"
  } else {
    $json = @{ memory = @{ provider = "honcho"; enabled = $true; baseUrl = $HonchoUrl; workspace = "freecode"; peer = "user" } } | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($settingsPath, $json)  # UTF-8, no BOM
    Ok "Wrote $settingsPath  (memory -> $HonchoUrl)"
  }
  try { $null = Invoke-WebRequest "$HonchoUrl/health" -TimeoutSec 5 -UseBasicParsing; Ok "Honcho reachable at $HonchoUrl [OK]" }
  catch { Warn "Honcho NOT reachable at $HonchoUrl - is Tailscale up? (memory is fail-soft; freecode still runs without it)" }
} else {
  Warn "No -HonchoUrl given -> shared memory not configured."
  Warn "Enable later:  ./setup.ps1 -HonchoUrl http://<honcho-host>:8100"
}

if (-not $SkipCheck) { Info "Typechecking ..."; bun run typecheck }

Info "`nDone. Launch freecode:"
Write-Host "  bun run src/cli.tsx"
Write-Host "Add a model:  set ANTHROPIC_API_KEY (or OPENAI_API_KEY ...), or run the REPL and use /provider."
Write-Host "On Tailscale? freecode auto-discovers your remote ollama/llama-server."
