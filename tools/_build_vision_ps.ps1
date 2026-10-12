# PowerShell 等价实现 tools/build-vision-msvc.sh（无 Git Bash 环境）
$ErrorActionPreference = "Stop"
$root = "C:\Users\harve\Desktop\Gobang auto"
$msvc = (Get-ChildItem "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC" -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
$bin = "$msvc\bin\Hostx64\x64"
$sdk = "10.0.26100.0"
$ocv = "$root\tools\opencv-build\build\install"
$env:INCLUDE = "$msvc\include;C:\Program Files (x86)\Windows Kits\10\Include\$sdk\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\$sdk\um;C:\Program Files (x86)\Windows Kits\10\Include\$sdk\shared;C:\Program Files (x86)\Windows Kits\10\Include\$sdk\winrt;C:\Program Files (x86)\Windows Kits\10\Include\$sdk\cppwinrt;$ocv\include"
$env:LIB = "$msvc\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\$sdk\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\$sdk\um\x64;$ocv\x64\vc18\staticlib"
$obj = "$root\desktop-vision\build\obj"
New-Item -ItemType Directory -Force -Path $obj | Out-Null
$cl = "$bin\cl.exe"
$link = "$bin\link.exe"
$dumpbin = "$bin\dumpbin.exe"
$srcs = @("gb","gbadaptive","gbdetector","gbrecognize","gbscreen","gbscanapi","gbhttp","gbpipe","main","gbloader","gbdll")
foreach ($s in $srcs) {
  $log = "$obj\$s.log"
  & $cl /nologo /c /O2 /Os /GL /MT /EHsc /std:c++17 /utf-8 /DUNICODE /D_UNICODE /DNDEBUG /wd4244 /wd4267 /wd4996 /Fo"$obj\$s.obj" "$root\desktop-vision\src\$s.cpp" 2>&1 | Out-File -Encoding utf8 $log
  if ($LASTEXITCODE -ne 0) { Write-Output "COMPILE FAIL $s"; Get-Content $log -Tail 20; exit 1 }
  Write-Output "ok $s"
}
$cvLibs = @("opencv_imgcodecs500.lib","opencv_imgproc500.lib","opencv_geometry500.lib","opencv_flann500.lib","opencv_core500.lib","opencv_dnn500.lib","libprotobuf.lib","libjpeg-turbo.lib","libpng.lib","libjasper.lib","libclapack.lib","zlib.lib","ittnotify.lib")
Write-Output "--- link exe ---"
& $link /nologo /OUT:"$root\desktop-vision\build\GomokuVision.exe" /SUBSYSTEM:CONSOLE /LTCG /OPT:REF /OPT:ICF /MACHINE:X64 "$obj\gb.obj" "$obj\gbhttp.obj" "$obj\gbpipe.obj" "$obj\main.obj" "$obj\gbloader.obj" ws2_32.lib user32.lib gdi32.lib advapi32.lib 2>&1 | Out-File -Encoding utf8 "$obj\link-exe.log"
if ($LASTEXITCODE -ne 0) { Write-Output "LINK EXE FAIL"; Get-Content "$obj\link-exe.log" -Tail 20; exit 1 }
Write-Output "--- link dll ---"
$model = "$obj\gb.obj $obj\gbadaptive.obj $obj\gbdetector.obj $obj\gbrecognize.obj $obj\gbscreen.obj $obj\gbscanapi.obj"
& $link /nologo /DLL /OUT:"$root\desktop-vision\build\GomokuVision.dll" /LTCG /OPT:REF /OPT:ICF /MACHINE:X64 "$obj\gb.obj" "$obj\gbadaptive.obj" "$obj\gbdetector.obj" "$obj\gbrecognize.obj" "$obj\gbscreen.obj" "$obj\gbscanapi.obj" "$obj\gbdll.obj" $cvLibs gdi32.lib user32.lib ole32.lib oleaut32.lib advapi32.lib shell32.lib shlwapi.lib 2>&1 | Out-File -Encoding utf8 "$obj\link-dll.log"
if ($LASTEXITCODE -ne 0) { Write-Output "LINK DLL FAIL"; Get-Content "$obj\link-dll.log" -Tail 20; exit 1 }
Write-Output "--- exports ---"
& $dumpbin /nologo /EXPORTS "$root\desktop-vision\build\GomokuVision.dll" 2>&1 | Out-File -Encoding utf8 "$obj\exports.log"
foreach ($fn in @("GbvScan","GbvScanImage","GbvRecognizeJson","GbvVersion")) {
  if (-not (Select-String -Path "$obj\exports.log" -Pattern $fn -Quiet)) { Write-Output "MISSING EXPORT $fn"; exit 1 }
}
Write-Output "EXPORTS OK: GbvScan / GbvScanImage / GbvRecognizeJson / GbvVersion"
Get-Item "$root\desktop-vision\build\GomokuVision.exe","$root\desktop-vision\build\GomokuVision.dll" | Select-Object Name, Length, LastWriteTime
