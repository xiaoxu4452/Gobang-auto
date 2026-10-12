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

# ★ 2026-10-02 任务 #93（视觉硬连接·定案架构）：识图是 EXE（壳），识别后台的模型是 DLL。
#   exe  = 识图服务壳：gb(JSON/工具) + gbhttp(HTTP) + gbpipe(命名管道+共享内存, #108)
#          + main(入口/路由) + gbloader(加载器)
#          —— **不链任何 OpenCV**，模型代码全仓库只有 DLL 这一份（不再两份冗余）；
#   dll  = 识别模型库：检测/读子/仲裁 + 抓屏核心 + gbscanapi(/scan 共享流程) + gbdll(导出层)
#          —— OpenCV（含 dnn/protobuf，YOLO 双链路）全在这里，壳崩溃隔离的边界在进程。
#   导出：GbvScan / GbvScanImage / GbvRecognizeJson / GbvVersion（缺一不可，
#         缺了壳的 /health 会 503 大声失败，宿主巡检能立刻发现）。
OBJS=()
for s in gb gbadaptive gbdetector gbrecognize gbscreen gbscanapi gbhttp gbpipe main gbloader gbdll; do
  echo "[bash-vision] 编译 $s.cpp ..."
  "$BIN/cl.exe" /nologo /c /O2 /Os /GL /MT /EHsc /std:c++17 /utf-8 /DUNICODE /D_UNICODE /DNDEBUG /wd4244 /wd4267 /wd4996 \
    /Fo"desktop-vision/build/obj/$s.obj" "desktop-vision/src/$s.cpp" > "desktop-vision/build/obj/$s.log" 2>&1 \
    || { tail -20 "desktop-vision/build/obj/$s.log"; exit 1; }
  grep -iE "error" "desktop-vision/build/obj/$s.log" | head -10 || true
  OBJS+=("desktop-vision/build/obj/$s.obj")
done

MODEL_OBJS=""
for s in gb gbadaptive gbdetector gbrecognize gbscreen gbscanapi; do
  MODEL_OBJS="$MODEL_OBJS desktop-vision/build/obj/$s.obj"
done
CV_LIBS="opencv_imgcodecs500.lib opencv_imgproc500.lib opencv_geometry500.lib opencv_flann500.lib opencv_core500.lib \
opencv_dnn500.lib libprotobuf.lib \
libjpeg-turbo.lib libpng.lib libjasper.lib libclapack.lib zlib.lib ittnotify.lib"

echo "[bash-vision] 链接 exe（识图服务壳，无 OpenCV）..."
"$BIN/link.exe" /nologo /OUT:"desktop-vision/build/GomokuVision.exe" /SUBSYSTEM:CONSOLE /LTCG /OPT:REF /OPT:ICF /MACHINE:X64 \
  desktop-vision/build/obj/gb.obj desktop-vision/build/obj/gbhttp.obj \
  desktop-vision/build/obj/gbpipe.obj \
  desktop-vision/build/obj/main.obj desktop-vision/build/obj/gbloader.obj \
  ws2_32.lib user32.lib gdi32.lib advapi32.lib
ls -la desktop-vision/build/GomokuVision.exe

echo "[bash-vision] 链接 dll（识别模型库）..."
"$BIN/link.exe" /nologo /DLL /OUT:"desktop-vision/build/GomokuVision.dll" /LTCG /OPT:REF /OPT:ICF /MACHINE:X64 \
  $MODEL_OBJS desktop-vision/build/obj/gbdll.obj \
  $CV_LIBS \
  gdi32.lib user32.lib ole32.lib oleaut32.lib advapi32.lib shell32.lib shlwapi.lib dxgi.lib d3d11.lib
ls -la desktop-vision/build/GomokuVision.dll

# 导出表守护：4 个导出缺一不可 —— 缺了壳的 /health 直接 503，宿主巡检立刻知道
echo "[bash-vision] 导出表验证 ..."
"$BIN/dumpbin.exe" /nologo /EXPORTS desktop-vision/build/GomokuVision.dll > desktop-vision/build/obj/exports.log
for fn in GbvScan GbvScanImage GbvRecognizeJson GbvVersion; do
  grep -qw "$fn" desktop-vision/build/obj/exports.log || { echo "[bash-vision] 缺导出 $fn"; exit 1; }
done
echo "[bash-vision] 导出齐全：GbvScan / GbvScanImage / GbvRecognizeJson / GbvVersion"
