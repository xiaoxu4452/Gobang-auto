#!/usr/bin/env bash
# 临时脚本：绕过 node spawnSync（沙箱 EBUSY），从 bash 驱动 MSVC 重建训练器 exe。
# 参数与 tools/build-calculator.js 逐条一致（含图标资源、独立版 + 三件套版）。
set -u

export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

ROOT="C:/Users/harve/Desktop/Gobang auto"
MSVC="C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231"
SDKI="C:/Program Files (x86)/Windows Kits/10/Include/10.0.26100.0"
SDKL="C:/Program Files (x86)/Windows Kits/10/Lib/10.0.26100.0"
SDKB="C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64"
W2="$ROOT/tools/webview2-sdk"

SRC="$ROOT/desktop-calculator/src/host.cpp"
OUTDIR="$ROOT/desktop-calculator/build"
OBJDIR="$OUTDIR/obj"
EXE="$OUTDIR/Desktop GomokuTrainer.exe"
SUITE_EXE="$OUTDIR/suite/Desktop GomokuTrainer.exe"

CL="$MSVC/bin/Hostx64/x64/cl.exe"
LK="$MSVC/bin/Hostx64/x64/link.exe"

export INCLUDE="$MSVC/include;$SDKI/ucrt;$SDKI/um;$SDKI/shared;$SDKI/winrt;$SDKI/cppwinrt"
export LIB="$MSVC/lib/x64;$SDKL/ucrt/x64;$SDKL/um/x64"

mkdir -p "$OBJDIR" "$OUTDIR/suite"

CLBASE=(/nologo /c /O2 /Os /GL /MT /EHsc /std:c++17 /utf-8
        /DUNICODE /D_UNICODE /DNDEBUG "/I$W2/include")

LKBASE=(/nologo /SUBSYSTEM:WINDOWS /LTCG /OPT:REF /OPT:ICF /MACHINE:X64
        "$W2/lib/x64/WebView2LoaderStatic.lib")
LIBS=(user32.lib gdi32.lib ole32.lib oleaut32.lib uuid.lib shell32.lib shlwapi.lib
      ws2_32.lib advapi32.lib comctl32.lib comdlg32.lib gdiplus.lib)

# ---- 图标资源 ----
ICON=()
if [ -f "$ROOT/desktop-calculator/src/Calculator.ico" ] && [ -f "$ROOT/desktop-calculator/src/icon.rc" ]; then
  if "$SDKB/rc.exe" /nologo "/fo$OBJDIR/icon.res" "$ROOT/desktop-calculator/src/icon.rc" >/dev/null 2>&1; then
    ICON=("$OBJDIR/icon.res")
    echo "[calc] 图标资源已编入"
  fi
fi

for variant in standalone suite; do
  if [ "$variant" = "standalone" ]; then
    OBJ="$OBJDIR/calc.obj"; OUT="$EXE"; EXTRA=()
  else
    OBJ="$OBJDIR/calc_suite.obj"; OUT="$SUITE_EXE"; EXTRA=(/DGB_SUITE_ENGINE)
  fi
  echo "[calc:$variant] 编译 host.cpp ..."
  "$CL" "${CLBASE[@]}" "${EXTRA[@]}" "/Fo$OBJ" "$SRC" || { echo "[calc:$variant] 编译失败"; exit 1; }
  echo "[calc:$variant] 链接 ..."
  "$LK" "${LKBASE[@]}" "/OUT:$OUT" "$OBJ" "${ICON[@]}" "${LIBS[@]}" ${EXTRA:+winhttp.lib} \
    || { echo "[calc:$variant] 链接失败"; exit 1; }
  ls -l "$OUT"
done

echo "[calc] done"
