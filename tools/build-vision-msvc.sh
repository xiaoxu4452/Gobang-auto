#!/bin/bash
set -e
# ★ 2026-09-26：Git Bash 会把 /O2 /MT 这类开关当路径转换成 "PortableGit/versions/.../O2"
#   → cl 全线报错。必须关掉 MSYS 路径转换（build-calculator-msvc.sh 早有此设置，这里补上）。
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
MSVC=$(ls -d "C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/"*/ | sort | tail -1)
BIN="${MSVC}bin/Hostx64/x64"
SDK="10.0.26100.0"
OCV="C:/Users/harve/Desktop/Gobang auto/tools/opencv-build/build/install"
cd "C:/Users/harve/Desktop/Gobang auto"
export INCLUDE="${MSVC}include;C:/Program Files (x86)/Windows Kits/10/Include/$SDK/ucrt;C:/Program Files (x86)/Windows Kits/10/Include/$SDK/um;C:/Program Files (x86)/Windows Kits/10/Include/$SDK/shared;C:/Program Files (x86)/Windows Kits/10/Include/$SDK/winrt;C:/Program Files (x86)/Windows Kits/10/Include/$SDK/cppwinrt;$OCV/include"
export LIB="${MSVC}lib/x64;C:/Program Files (x86)/Windows Kits/10/Lib/$SDK/ucrt/x64;C:/Program Files (x86)/Windows Kits/10/Lib/$SDK/um/x64;$OCV/x64/vc18/staticlib"
mkdir -p desktop-vision/build/obj
OBJS=()
for s in gb gbadaptive gbdetector gbhttp gbrecognize gbscreen main; do
  echo "[bash-vision] 编译 $s.cpp ..."
  "$BIN/cl.exe" /nologo /c /O2 /Os /GL /MT /EHsc /std:c++17 /utf-8 /DUNICODE /D_UNICODE /DNDEBUG /wd4244 /wd4267 /wd4996 \
    /Fo"desktop-vision/build/obj/$s.obj" "desktop-vision/src/$s.cpp" > "desktop-vision/build/obj/$s.log" 2>&1 \
    || { tail -20 "desktop-vision/build/obj/$s.log"; exit 1; }
  grep -iE "error" "desktop-vision/build/obj/$s.log" | head -10 || true
  OBJS+=("desktop-vision/build/obj/$s.obj")
done
echo "[bash-vision] 链接 ..."
"$BIN/link.exe" /nologo /OUT:"desktop-vision/build/GomokuVision.exe" /SUBSYSTEM:CONSOLE /LTCG /OPT:REF /OPT:ICF /MACHINE:X64 \
  "${OBJS[@]}" \
  opencv_imgcodecs500.lib opencv_imgproc500.lib opencv_geometry500.lib opencv_flann500.lib opencv_core500.lib \
  libjpeg-turbo.lib libpng.lib libjasper.lib libclapack.lib zlib.lib ittnotify.lib \
  ws2_32.lib gdi32.lib user32.lib ole32.lib oleaut32.lib advapi32.lib shell32.lib shlwapi.lib
ls -la desktop-vision/build/GomokuVision.exe
