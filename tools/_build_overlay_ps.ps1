# PowerShell 等价实现 tools/build-overlay-msvc.sh --standalone（无 Git Bash）
$ErrorActionPreference = "Stop"
$root = "C:\Users\harve\Desktop\Gobang auto"
$msvc = "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.51.36231"
$sdki = "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0"
$sdkl = "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0"
$sdkb = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64"
$w2 = "$root\tools\webview2-sdk"
$src = "$root\desktop-overlay\src\host.cpp"
$outdir = "$root\desktop-overlay\build"
$objdir = "$outdir\obj"
New-Item -ItemType Directory -Force -Path $objdir | Out-Null
$env:INCLUDE = "$msvc\include;$sdki\ucrt;$sdki\um;$sdki\shared;$sdki\winrt;$sdki\cppwinrt"
$env:LIB = "$msvc\lib\x64;$sdkl\ucrt\x64;$sdkl\um\x64"
$cl = "$msvc\bin\Hostx64\x64\cl.exe"
$lk = "$msvc\bin\Hostx64\x64\link.exe"
$exe = "$outdir\Desktop GomokuAssistant.exe"
Write-Output "[overlay] compile host.cpp (standalone)..."
& $cl /nologo /c /O2 /Os /GL /MT /EHsc /std:c++17 /utf-8 /DUNICODE /D_UNICODE /DNDEBUG /DGB_ASSISTANT_STANDALONE "/I$w2\include" "/Fo$objdir\host.obj" $src 2>&1 | Out-File -Encoding utf8 "$objdir\host.log"
if ($LASTEXITCODE -ne 0) { Write-Output "COMPILE FAIL"; Get-Content "$objdir\host.log" -Tail 25; exit 1 }
Write-Output "[overlay] icon..."
$iconRes = "$objdir\icon.res"
$iconArgs = @()
if ((Test-Path "$root\desktop-overlay\src\GomokuOverlay.ico") -and (Test-Path "$root\desktop-overlay\src\icon.rc")) {
  & "$sdkb\rc.exe" /nologo "/fo$iconRes" "$root\desktop-overlay\src\icon.rc" 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $iconArgs = @($iconRes); Write-Output "icon ok" }
}
Write-Output "[overlay] link..."
& $lk /nologo "/OUT:$exe" /SUBSYSTEM:WINDOWS /LTCG /OPT:REF /OPT:ICF /MACHINE:X64 "$objdir\host.obj" "$w2\lib\x64\WebView2LoaderStatic.lib" gdiplus.lib gdi32.lib user32.lib ole32.lib oleaut32.lib uuid.lib winhttp.lib shell32.lib shlwapi.lib advapi32.lib dwmapi.lib comctl32.lib comdlg32.lib @iconArgs 2>&1 | Out-File -Encoding utf8 "$objdir\link.log"
if ($LASTEXITCODE -ne 0) { Write-Output "LINK FAIL"; Get-Content "$objdir\link.log" -Tail 25; exit 1 }
Remove-Item "$outdir\WebView2Loader.dll","$outdir\GomokuOverlay.exe" -Force -ErrorAction SilentlyContinue
Get-Item $exe | Select-Object FullName, Length, LastWriteTime
Write-Output "[overlay] done"
