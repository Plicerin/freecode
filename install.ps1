# freecode one-command installer (Windows).
#   From inside a clone:  ./install.ps1 -HonchoUrl http://<host>:8100
# Does everything: installs Bun if missing, syncs this branch, bun install, writes
# ~/.freecode/settings.json (shared memory), and installs an AUTO-UPDATING
# `freecode` launcher into your PowerShell profile. After this, just type
# `freecode` in any folder - it fast-forwards to the latest (at most hourly) and
# runs from source, so you're always current. Set FREECODE_NO_UPDATE=1 to skip
# the update check for a launch.
#
# Keep this file ASCII-only (Windows PowerShell 5.1 reads a BOM-less script as
# ANSI, so a stray curly char would corrupt the parse). And 5.1-compatible: NO
# ternary (? :), null-coalescing (??), or ?. — those are PowerShell 7 only and
# 5.1 (the default shell on Windows) rejects them at parse time. Validate with
# powershell.exe, not just pwsh (tests/install-scripts.test.ts does this).
param(
  [string]$Branch = "feat/tier-a-parity",
  [string]$HonchoUrl = $env:FREECODE_HONCHO_URL,  # optional; enables cross-machine memory
  [switch]$NoUpdateHook                            # install without the auto-update-on-launch behavior
)
$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot
Set-Location $repo

function Have($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }

Info "== freecode installer =="
Info ("repo: {0}" -f $repo)

# --- Bun ---
if (-not (Have bun)) {
  Warn "Bun not found - installing from bun.sh ..."
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  $env:Path = "$HOME\.bun\bin;$env:Path"
  if (-not (Have bun)) { throw "Bun installed but not on PATH. Open a new terminal and re-run ./install.ps1" }
}
Ok ("bun " + (bun --version))

# --- Sync branch (best-effort; the repo is already cloned) ---
if (Have git) {
  Info "Syncing to branch '$Branch' ..."
  try { git fetch --quiet origin; git checkout $Branch; git pull --ff-only } catch { Warn "git sync skipped ($($_.Exception.Message)). Continuing on the current checkout." }
} else {
  Warn "git not on PATH here - skipping branch sync (ensure you're on '$Branch')."
}

# --- Deps ---
Info "Installing deps (bun install) ..."
bun install

# --- Shared memory config (non-destructive) ---
$appDir = Join-Path $HOME ".freecode"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
$settingsPath = Join-Path $appDir "settings.json"
if ($HonchoUrl) {
  if (Test-Path $settingsPath) {
    Warn "settings.json already exists - leaving it. To enable shared memory add a `"memory`" block with baseUrl=$HonchoUrl."
  } else {
    (@{ memory = @{ provider = "honcho"; enabled = $true; baseUrl = $HonchoUrl; workspace = "freecode"; peer = "user" } } | ConvertTo-Json -Depth 6) |
      ForEach-Object { [System.IO.File]::WriteAllText($settingsPath, $_) }
    Ok "Wrote $settingsPath  (memory -> $HonchoUrl)"
  }
}

# --- Auto-updating launcher into the PowerShell profile ---
$launcher = @"
# >>> freecode launcher (auto-updating) >>>
function freecode {
  `$repo = "$repo"
  if (-not `$env:FREECODE_NO_UPDATE -and (Get-Command git -ErrorAction SilentlyContinue)) {
    `$stamp = Join-Path `$HOME ".freecode\update-stamp"
    `$due = -not (Test-Path `$stamp) -or (((Get-Date) - (Get-Item `$stamp).LastWriteTime).TotalHours -ge 1)
    if (`$due) {
      try { git -C `$repo pull --ff-only --quiet 2>`$null } catch {}
      New-Item -ItemType Directory -Force -Path (Split-Path `$stamp) | Out-Null
      Set-Content -Path `$stamp -Value (Get-Date) -ErrorAction SilentlyContinue
    }
  }
  bun run "`$repo\src\cli.tsx" @args
}
# <<< freecode launcher <<<
"@

if ($NoUpdateHook) {
  $launcher = "# >>> freecode launcher (auto-updating) >>>`nfunction freecode { bun run `"$repo\src\cli.tsx`" @args }`n# <<< freecode launcher <<<"
}

$profilePath = $PROFILE.CurrentUserAllHosts
New-Item -ItemType Directory -Force -Path (Split-Path $profilePath) | Out-Null
$existing = if (Test-Path $profilePath) { Get-Content $profilePath -Raw } else { "" }
# Remove any prior freecode launcher block (idempotent) or a legacy one-line alias.
$cleaned = [regex]::Replace($existing, "(?s)# >>> freecode launcher.*?# <<< freecode launcher[^\r\n]*\r?\n?", "")
$cleaned = ($cleaned -split "`r?`n" | Where-Object { $_ -notmatch '^\s*function\s+freecode\s*\{.*bun.*cli\.tsx' }) -join "`n"
$new = ($cleaned.TrimEnd() + "`n`n" + $launcher + "`n").TrimStart()
[System.IO.File]::WriteAllText($profilePath, $new)
Ok ("Installed the 'freecode' launcher -> {0}" -f $profilePath)

Info "`nDone. Open a NEW terminal (or run: . `$PROFILE.CurrentUserAllHosts), then from any folder:"
Write-Host "  freecode"
Write-Host "It auto-updates on launch (hourly, best-effort). Skip once with: `$env:FREECODE_NO_UPDATE=1"
Write-Host "Add a model: set ANTHROPIC_API_KEY (etc.), or use /provider in the REPL. On Tailscale, remote servers are auto-discovered."
