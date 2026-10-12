# PowerShell equivalent of the key-injection block in build-connect-msvc.sh.
# Injects CALC_UI_KEY from encrypt-calc-ui.js into ui_crypto.h, builds, then restores.
$ErrorActionPreference = "Stop"
$root = "C:\Users\harve\Desktop\Gobang auto"
$node = "C:\Users\harve\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
$h = "$root\desktop-connect\src\ui_crypto.h"

# 1) Extract the 32-char key from encrypt-calc-ui.js (single source of truth).
$rootFwd = $root.Replace('\', '/')
$key = & $node -e "const fs=require('fs');const s=fs.readFileSync('$rootFwd/tools/encrypt-calc-ui.js','utf8');const m=/CALC_UI_KEY = '([^']{32})'/.exec(s);if(!m){console.error('no key');process.exit(1)}console.log(m[1])"
if ($LASTEXITCODE -ne 0 -or $key.Length -ne 32) { Write-Output "KEY EXTRACT FAIL: len=$($key.Length)"; exit 1 }
Write-Output "[connect] key ok (32 chars)"

# 2) Backup and inject (refuse if not the empty placeholder).
$raw = [IO.File]::ReadAllText($h)
$ph = 'GB_CALC_UI_KEY = ""'
if ($raw.IndexOf($ph) -lt 0) { Write-Output "NOT EMPTY PLACEHOLDER, ABORT"; exit 1 }
$injected = $raw.Replace($ph, 'GB_CALC_UI_KEY = "' + $key + '"')
$restored = $false
try {
  [IO.File]::WriteAllText($h, $injected, (New-Object Text.UTF8Encoding $false))
  # 3) Run the build script (compiles host.cpp with key + re-encrypts UI).
  & powershell -ExecutionPolicy Bypass -File "$root\tools\_build_connect_ps.ps1"
  if ($LASTEXITCODE -ne 0) { Write-Output "BUILD FAIL"; exit 1 }
} finally {
  # 4) Always restore the header so the repo stays key-free.
  [IO.File]::WriteAllText($h, $raw, (New-Object Text.UTF8Encoding $false))
  $restored = $true
  Write-Output "[connect] ui_crypto.h restored (key-free)"
}
Write-Output "[connect] done"
