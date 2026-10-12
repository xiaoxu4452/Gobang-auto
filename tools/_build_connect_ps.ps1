# PowerShell 等价实现 tools/build-connect-msvc.sh（无 Git Bash）
# 产物直接发布到 Meter Gomoku\：Desktop GomokuTrainer.exe + calc\*.enc
$ErrorActionPreference = "Stop"
$root = "C:\Users\harve\Desktop\Gobang auto"
$node = "C:\Users\harve\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
$msvc = "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.51.36231"
$sdki = "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0"
$sdkl = "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0"
$sdkb = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64"
$w2 = "$root\tools\webview2-sdk"
$src = "$root\desktop-connect\src\host.cpp"
$outdir = "$root\desktop-connect\build"
$objdir = "$outdir\obj"
$rel = "$root\Meter Gomoku"
New-Item -ItemType Directory -Force -Path $objdir | Out-Null

# ---- 版本资源（连线版 4.37）----
Write-Output "[connect] gen appver..."
& $node "$root\tools\gen-appver-rc.js" --ver 4.37 --calc "$root\desktop-connect\ui\calc.js" --out-dir "$root\desktop-connect\src" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Output "GEN APPVEr FAIL"; exit 1 }

$env:INCLUDE = "$msvc\include;$sdki\ucrt;$sdki\um;$sdki\shared;$sdki\winrt;$sdki\cppwinrt"
$env:LIB = "$msvc\lib\x64;$sdkl\ucrt\x64;$sdkl\um\x64"
$cl = "$msvc\bin\Hostx64\x64\cl.exe"
$lk = "$msvc\bin\Hostx64\x64\link.exe"
$exe = "$rel\Desktop GomokuTrainer.exe"

Write-Output "[connect] icon..."
$iconArgs = @()
$iconRes = "$objdir\icon.res"
if ((Test-Path "$root\desktop-connect\src\Calculator.ico") -and (Test-Path "$root\desktop-connect\src\icon.rc")) {
  & "$sdkb\rc.exe" /nologo "/fo$iconRes" "$root\desktop-connect\src\icon.rc" 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $iconArgs = @($iconRes); Write-Output "icon ok" }
}

Write-Output "[connect] compile host.cpp..."
& $cl /nologo /c /O2 /Os /GL /MT /EHsc /std:c++17 /utf-8 /DUNICODE /D_UNICODE /DNDEBUG "/I$w2\include" "/Fo$objdir\connect.obj" $src 2>&1 | Out-File -Encoding utf8 "$objdir\connect.log"
if ($LASTEXITCODE -ne 0) { Write-Output "COMPILE FAIL"; Get-Content "$objdir\connect.log" -Tail 25; exit 1 }

Write-Output "[connect] link..."
& $lk /nologo "/OUT:$exe" /SUBSYSTEM:WINDOWS /LTCG /OPT:REF /OPT:ICF /MACHINE:X64 "$objdir\connect.obj" "$w2\lib\x64\WebView2LoaderStatic.lib" user32.lib gdi32.lib ole32.lib oleaut32.lib uuid.lib shell32.lib shlwapi.lib ws2_32.lib advapi32.lib comctl32.lib comdlg32.lib gdiplus.lib winhttp.lib @iconArgs 2>&1 | Out-File -Encoding utf8 "$objdir\link.log"
if ($LASTEXITCODE -ne 0) { Write-Output "LINK FAIL"; Get-Content "$objdir\link.log" -Tail 25; exit 1 }

Write-Output "[connect] encrypt ui -> $rel\calc"
& $node "$root\tools\encrypt-calc-ui.js" --src "$root\desktop-connect\ui" --out "$rel\calc" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Output "ENCRYPT FAIL"; exit 1 }

Get-Item $exe | Select-Object FullName, Length, LastWriteTime
Write-Output "[connect] done -> $rel"
