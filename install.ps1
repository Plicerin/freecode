# freecode installer (Windows).
#   From a clone or anywhere:  ./install.ps1 -HonchoUrl http://<host>:8100
# Installs the PUBLISHED npm package globally (runs on plain Node — no Bun, no
# clone to maintain), and REMOVES any old auto-updating source launcher that used
# to shadow it. After this, `freecode` in any folder is exactly what you
# installed; update later with `freecode update`.
#
# Keep this file ASCII-only and Windows PowerShell 5.1-compatible: NO ternary
# (? :), null-coalescing (??), or ?. — those are PowerShell 7 only and 5.1 (the
# default shell on Windows) rejects them at parse time. Validate with
# powershell.exe, not just pwsh (tests/install-scripts.test.ts does this).
param(
  [string]$HonchoUrl = $env:FREECODE_HONCHO_URL  # optional; enables cross-machine memory
)
$ErrorActionPreference = "Stop"

function Have($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }

Info "== freecode installer =="

# --- Node / npm ---
if (-not (Have npm)) {
  Warn "npm (Node.js) not found."
  Warn "Install Node 18+ from https://nodejs.org  (or: winget install OpenJS.NodeJS.LTS), then re-run this script."
  throw "npm is required"
}
Ok ("node " + (node --version) + "  npm " + (npm --version))

# --- Install the published package globally ---
Info "Installing @vrocket/freecode (global) ..."
npm install -g "@vrocket/freecode@latest"
if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
Ok "Installed. 'freecode' is on your PATH."

# --- Remove the OLD auto-updating source launcher (it SHADOWED the npm install) ---
# A PowerShell function named 'freecode' beats a PATH executable, so the old
# installer's profile function ran a bun/git-clone source build instead of what
# you installed. It can hide in ANY of the profile files: Windows PowerShell 5.1
# (Documents\WindowsPowerShell\) and PowerShell 7 (Documents\PowerShell\) use
# DIFFERENT folders, and each has profile.ps1 (all hosts) + Microsoft.PowerShell_
# profile.ps1 (current host). Documents may also be OneDrive-redirected. Scrub
# every candidate regardless of which edition is running this script — cleaning
# only the current edition's $PROFILE (the old bug) left the launcher in place.
$docRoots = @(
  [Environment]::GetFolderPath("MyDocuments"),
  (Join-Path $HOME "Documents"),
  (Join-Path $HOME "OneDrive\Documents")
) | Where-Object { $_ } | Select-Object -Unique
$candidates = @()
foreach ($doc in $docRoots) {
  foreach ($edition in @("WindowsPowerShell", "PowerShell")) {
    foreach ($hostFile in @("profile.ps1", "Microsoft.PowerShell_profile.ps1")) {
      $candidates += (Join-Path $doc (Join-Path $edition $hostFile))
    }
  }
}
$candidates = $candidates | Select-Object -Unique
$removedAny = $false
foreach ($profilePath in $candidates) {
  if (-not (Test-Path $profilePath)) { continue }
  $existing = Get-Content $profilePath -Raw
  # (1) marker-block form:  # >>> freecode launcher ... # <<< freecode launcher
  $cleaned = [regex]::Replace($existing, "(?s)# >>> freecode launcher.*?# <<< freecode launcher[^\r\n]*\r?\n?", "")
  # (2) bare one-line function form:  function freecode { ... src\cli.tsx ... }
  $cleaned = ($cleaned -split "`r?`n" | Where-Object { $_ -notmatch '^\s*function\s+freecode\b.*cli\.tsx' }) -join "`n"
  if ($cleaned -ne $existing) {
    try {
      [System.IO.File]::WriteAllText($profilePath, $cleaned)
      Warn ("Removed the old 'freecode' launcher from " + $profilePath + " (it was shadowing the npm install).")
      $removedAny = $true
    } catch {
      Warn ("Found the old 'freecode' launcher in " + $profilePath + " but could not edit it: " + $_.Exception.Message)
    }
  }
}
if ($removedAny) {
  Warn "Open a NEW terminal so the change takes effect (the launcher is cached in your current session)."
}

# --- Shared memory config (non-destructive) ---
$appDir = Join-Path $HOME ".freecode"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
$settingsPath = Join-Path $appDir "settings.json"
if ($HonchoUrl) {
  if (Test-Path $settingsPath) {
    Warn ("settings.json already exists - leaving it. To enable shared memory add a memory block with baseUrl=" + $HonchoUrl + ".")
  } else {
    (@{ memory = @{ provider = "honcho"; enabled = $true; baseUrl = $HonchoUrl; workspace = "freecode"; peer = "user" } } | ConvertTo-Json -Depth 6) |
      ForEach-Object { [System.IO.File]::WriteAllText($settingsPath, $_) }
    Ok ("Wrote " + $settingsPath + "  (memory -> " + $HonchoUrl + ")")
  }
}

Info "`nDone. Open a NEW terminal, then from any folder:"
Write-Host "  freecode"
Write-Host "Update later with:  freecode update   (or: npm i -g @vrocket/freecode@latest)"
Write-Host "Add a model: set ANTHROPIC_API_KEY (etc.), or use /provider in the REPL. On Tailscale, remote servers are auto-discovered."
