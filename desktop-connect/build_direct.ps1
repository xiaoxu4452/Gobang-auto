# Build the RapFi function-direct host (METER_RAPFI_DIRECT) with MSVC.
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\harve\Desktop\Gobang auto'
$dc   = "$root\desktop-connect"
$rf   = "$dc\rapfi"

# ---- inject UI decryption key (single source: tools/encrypt-connect-ui.js) ----
$keyJs = Get-Content "$root\tools\encrypt-connect-ui.js" -Raw
$km = [regex]::Match($keyJs, "CALC_UI_KEY\s*=\s*'([^']{32})'")
if (-not $km.Success) { Write-Output 'KEY NOT FOUND'; exit 1 }
$uiKey = $km.Groups[1].Value
$hPath = "$dc\src\ui_crypto.h"
$rawH = [IO.File]::ReadAllText($hPath)
$injectH = $rawH.Replace('GB_CALC_UI_KEY = ""', "GB_CALC_UI_KEY = `"$uiKey`"")
[IO.File]::WriteAllText($hPath, $injectH, (New-Object Text.UTF8Encoding $false))
try {
$inc  = @(
  "$dc\src",
  "$dc\src\rapfi-lib",
  "$root\desktop-overlay\webview2\include",
  "$rf",
  "$rf\external\simde\include",
  "$rf\external\cpptoml\include",
  "$rf\external\cxxopts\include",
  "$rf\external\lz4\lib",
  "$rf\external\lz4\include",
  "$rf\external\zip\src",
  "$rf\external\BS_thread_pool\include",
  "$rf\external\flat.hpp\headers",
  "$rf\external\libnpy\include",
  "$rf\external\npy"
)
$incArgs = ($inc | ForEach-Object { '/I' + '"' + $_ + '"' }) -join ' '

$libs = @(
  "$rf\meterrapfi.lib",
  "$rf\build-test\external\lz4\Release\lz4.lib",
  "$rf\build-test\external\zip\Release\zip.lib",
  "$root\desktop-overlay\webview2\x64\WebView2LoaderStatic.lib",
  'user32.lib','gdi32.lib','shell32.lib','ole32.lib','comdlg32.lib',
  'shlwapi.lib','dwmapi.lib','winmm.lib','ws2_32.lib','advapi32.lib','gdiplus.lib',
  'oleaut32.lib','uuid.lib','version.lib'
) | ForEach-Object { if ($_ -like '*\*' -or $_ -like '*:*') { '"' + $_ + '"' } else { $_ } }
$libs = $libs -join ' '

$out = "$dc\build_direct"
New-Item -ItemType Directory -Force $out | Out-Null

$vc = Get-ChildItem 'C:\Program Files*\Microsoft Visual Studio\18\*\VC\Auxiliary\Build\vcvars64.bat' -ErrorAction SilentlyContinue |
      Select-Object -First 1
if (-not $vc) { $vc = Get-ChildItem 'C:\Program Files*\Microsoft Visual Studio\202*\*\VC\Auxiliary\Build\vcvars64.bat' -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $vc) { Write-Output 'VCVARS NOT FOUND'; exit 2 }
Write-Output "vcvars: $($vc.FullName)"

$srcs = "`"$dc\src\host.cpp`" `"$dc\src\rapfi-lib\meter_api.cpp`""
$cmd = "call `"$($vc.FullName)`" && rc /fo `"$out\host.res`" `"$out\host.rc`" && cl /nologo /O2 /MD /std:c++20 /EHsc /W3 /DUNICODE /D_UNICODE /DMETER_RAPFI_DIRECT $incArgs $srcs `"$out\host.res`" /Fe:`"$out\GomokuLinkDirect.exe`" /link $libs"
Write-Output "COMPILING (this can take a few minutes)..."
& cmd /c $cmd
if ($LASTEXITCODE -ne 0) { Write-Output "BUILD FAIL $LASTEXITCODE"; exit 1 }

$exe = "$out\GomokuLinkDirect.exe"
if (Test-Path $exe) { Write-Output "OK $exe $((Get-Item $exe).Length)" } else { Write-Output 'NO OUTPUT EXE'; exit 1 }
} finally {
  [IO.File]::WriteAllText($hPath, $rawH, (New-Object Text.UTF8Encoding $false))
  Write-Output '[connect] ui_crypto.h restored (key-free)'
}
