#!/bin/bash
set -e
# Zhizi test model build. Same toolchain/layout as build-vision-msvc.sh,
# but stone reading uses the readboard (Zhizi) classifier instead of the
# adaptive reader. Board detection (locateBoard) is unchanged.
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
MSVC=$(ls -d "C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/"*/ | sort | tail -1)
BIN="${MSVC}bin/Hostx64/x64"
SDK="10.0.26100.0"
OCV="C:/Users/harve/Desktop/Gobang auto/tools/opencv-build/build/install"
cd "C:/Users/harve/Desktop/Gobang auto"
export INCLUDE="${MSVC}include;C:/Program Files (x86)/Windows Kits/10/Include/$SDK/ucrt;C:/Program Files (x86)/Windows Kits/10/Include/$SDK/um;C:/Program Files (x86)/Windows Kits/10/Include/$SDK/shared;C:/Program Files (x86)/Windows Kits/10/Include/$SDK/winrt;C:/Program Files (x86)/Windows Kits/10/Include/$SDK/cppwinrt;$OCV/include"
export LIB="${MSVC}lib/x64;C:/Program Files (x86)/Windows Kits/10/Lib/$SDK/ucrt/x64;C:/Program Files (x86)/Windows Kits/10/Lib/$SDK/um/x64;$OCV/x64/vc18/staticlib"
mkdir -p desktop-vision-zhizi/build/obj

OBJS=()
for s in gb gbadaptive gbzhizi gbdetector gbrecognize gbscreen gbscanapi gbhttp gbpipe main gbloader gbdll; do
  echo "[bash-vision-zhizi] compile $s.cpp ..."
  "$BIN/cl.exe" /nologo /c /O2 /Os /GL /MT /EHsc /std:c++17 /utf-8 /DUNICODE /D_UNICODE /DNDEBUG /wd4244 /wd4267 /wd4996 \
    /Fo"desktop-vision-zhizi/build/obj/$s.obj" "desktop-vision-zhizi/src/$s.cpp" > "desktop-vision-zhizi/build/obj/$s.log" 2>&1 \
    || { tail -20 "desktop-vision-zhizi/build/obj/$s.log"; exit 1; }
  grep -iE "error" "desktop-vision-zhizi/build/obj/$s.log" | head -10 || true
  OBJS+=("desktop-vision-zhizi/build/obj/$s.obj")
done

MODEL_OBJS=""
for s in gb gbadaptive gbzhizi gbdetector gbrecognize gbscreen gbscanapi; do
  MODEL_OBJS="$MODEL_OBJS desktop-vision-zhizi/build/obj/$s.obj"
done
CV_LIBS="opencv_imgcodecs500.lib opencv_imgproc500.lib opencv_geometry500.lib opencv_flann500.lib opencv_core500.lib \
opencv_dnn500.lib libprotobuf.lib \
libjpeg-turbo.lib libpng.lib libjasper.lib libclapack.lib zlib.lib ittnotify.lib"

echo "[bash-vision-zhizi] link exe ..."
"$BIN/link.exe" /nologo /OUT:"desktop-vision-zhizi/build/GomokuVision.exe" /SUBSYSTEM:CONSOLE /LTCG /OPT:REF /OPT:ICF /MACHINE:X64 \
  desktop-vision-zhizi/build/obj/gb.obj desktop-vision-zhizi/build/obj/gbhttp.obj \
  desktop-vision-zhizi/build/obj/gbpipe.obj \
  desktop-vision-zhizi/build/obj/main.obj desktop-vision-zhizi/build/obj/gbloader.obj \
  ws2_32.lib user32.lib gdi32.lib advapi32.lib
ls -la desktop-vision-zhizi/build/GomokuVision.exe

echo "[bash-vision-zhizi] link dll ..."
"$BIN/link.exe" /nologo /DLL /OUT:"desktop-vision-zhizi/build/GomokuVision.dll" /LTCG /OPT:REF /OPT:ICF /MACHINE:X64 \
  $MODEL_OBJS desktop-vision-zhizi/build/obj/gbdll.obj \
  $CV_LIBS \
  gdi32.lib user32.lib ole32.lib oleaut32.lib advapi32.lib shell32.lib shlwapi.lib dxgi.lib d3d11.lib
ls -la desktop-vision-zhizi/build/GomokuVision.dll

echo "[bash-vision-zhizi] export check ..."
"$BIN/dumpbin.exe" /nologo /EXPORTS desktop-vision-zhizi/build/GomokuVision.dll > desktop-vision-zhizi/build/obj/exports.log
for fn in GbvScan GbvScanImage GbvRecognizeJson GbvVersion; do
  grep -qw "$fn" desktop-vision-zhizi/build/obj/exports.log || { echo "[bash-vision-zhizi] missing export $fn"; exit 1; }
done
echo "[bash-vision-zhizi] exports ok: GbvScan / GbvScanImage / GbvRecognizeJson / GbvVersion"
