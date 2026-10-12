#!/usr/bin/env bash
# 临时脚本：绕过 node spawnSync（沙箱 EBUSY），从 bash 驱动 MSVC 重建覆盖层 exe。
# 参数与 tools/build-overlay.js 逐条一致（含图标资源；--publish = 发布到 Desktop version）。
# UI 提取/加密不在此做 —— 先手动跑：
#   node tools/extract-panel-ui.js && node tools/encrypt-overlay-ui.js
set -u

export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

ROOT="C:/Users/harve/Desktop/Gobang auto"
MSVC="C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231"
SDKI="C:/Program Files (x86)/Windows Kits/10/Include/10.0.26100.0"
SDKL="C:/Program Files (x86)/Windows Kits/10/Lib/10.0.26100.0"
SDKB="C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64"
W2="$ROOT/tools/webview2-sdk"

SRC="$ROOT/desktop-overlay/src/host.cpp"
OUTDIR="$ROOT/desktop-overlay/build"
OBJDIR="$OUTDIR/obj"

# ★ --standalone（2026-10-03）：第三版本「单桌面版五子棋助手」——
#   编译期宏 GB_ASSISTANT_STANDALONE 打开激进单硬 C++ 连接（引擎进 job 随宿主生死，
#   不收养不道别），产物名 Desktop GomokuAssistant.exe，发布目录 Meter GomokuAssistant。
STANDALONE=0
[ "${1:-}" = "--standalone" ] && STANDALONE=1
if [ "$STANDALONE" = "1" ]; then
  EXE="$OUTDIR/Desktop GomokuAssistant.exe"
  DEFINE="/DGB_ASSISTANT_STANDALONE"
else
  EXE="$OUTDIR/Desktop GomokuOverlay.exe"
  DEFINE=""
fi

CL="$MSVC/bin/Hostx64/x64/cl.exe"
LK="$MSVC/bin/Hostx64/x64/link.exe"

export INCLUDE="$MSVC/include;$SDKI/ucrt;$SDKI/um;$SDKI/shared;$SDKI/winrt;$SDKI/cppwinrt"
export LIB="$MSVC/lib/x64;$SDKL/ucrt/x64;$SDKL/um/x64"

mkdir -p "$OBJDIR"

echo "[overlay] 编译 host.cpp ...$([ "$STANDALONE" = "1" ] && echo '（单机版 GB_ASSISTANT_STANDALONE）')"
"$CL" /nologo /c /O2 /Os /GL /MT /EHsc /std:c++17 /utf-8 \
      /DUNICODE /D_UNICODE /DNDEBUG $DEFINE "/I$W2/include" \
      "/Fo$OBJDIR/host.obj" "$SRC" || { echo "[overlay] 编译失败"; exit 1; }

# ---- 图标：把 .ico 编进 exe ----
ICON=()
ICON_RES="$OBJDIR/icon.res"
if [ -f "$ROOT/desktop-overlay/src/GomokuOverlay.ico" ] && [ -f "$ROOT/desktop-overlay/src/icon.rc" ]; then
  if "$SDKB/rc.exe" /nologo "/fo$ICON_RES" "$ROOT/desktop-overlay/src/icon.rc" >/dev/null 2>&1; then
    ICON=("$ICON_RES")
    echo "[overlay] 图标资源已编入"
  fi
fi

echo "[overlay] 链接 ..."
"$LK" /nologo "/OUT:$EXE" /SUBSYSTEM:WINDOWS /LTCG /OPT:REF /OPT:ICF /MACHINE:X64 \
      "$OBJDIR/host.obj" "$W2/lib/x64/WebView2LoaderStatic.lib" \
      gdiplus.lib gdi32.lib user32.lib ole32.lib oleaut32.lib uuid.lib \
      winhttp.lib shell32.lib shlwapi.lib advapi32.lib \
      dwmapi.lib comctl32.lib comdlg32.lib "${ICON[@]}" \
      || { echo "[overlay] 链接失败"; exit 1; }

ls -la "$EXE"

# 清掉误留的裸 dll（静态链接后不需要）与旧名遗留
rm -f "$OUTDIR/WebView2Loader.dll" "$OUTDIR/host.obj" "$OUTDIR/GomokuOverlay.exe" 2>/dev/null

# ---------------------------------------------------------------- 发布
if [ "${1:-}" = "--publish" ]; then
  PUB="$ROOT/Desktop version"
  mkdir -p "$PUB"
  cp -f "$OUTDIR/Desktop GomokuOverlay.exe" "$PUB/Desktop GomokuOverlay.exe"
  # overlay/：面板 UI。只带加密后的 .enc（明文一个都不发布），并清掉历史遗留明文
  mkdir -p "$PUB/overlay"
  N=0
  for f in "$ROOT/desktop-overlay/ui/"*.enc; do
    [ -e "$f" ] || continue
    cp -f "$f" "$PUB/overlay/"; N=$((N+1))
  done
  find "$PUB/overlay" -maxdepth 1 -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' \) ! -name '*.enc' -delete 2>/dev/null
  [ "$N" = "0" ] && echo "[overlay] 警告：overlay/ 里没有任何 .enc（面板会打不开）"
  for p in overlay-readme-zh.md:README_zh.md overlay-readme-en.md:README_en.md; do
    SRC_MD="$ROOT/tools/${p%%:*}"; DST_MD="$PUB/${p##*:}"
    [ -f "$SRC_MD" ] && cp -f "$SRC_MD" "$DST_MD"
  done
  echo "[overlay] ✓ 已发布到 Desktop version（exe + overlay/*.enc 仅密文 + README）"
fi

# ---- 单机版发布（--standalone --publish 时落到专用目录）----
if [ "$STANDALONE" = "1" ] && [ "${2:-}" = "--publish" ]; then
  PUB="$ROOT/Meter GomokuAssistant"
  mkdir -p "$PUB/overlay"
  cp -f "$EXE" "$PUB/Desktop GomokuAssistant.exe"
  N=0
  for f in "$ROOT/desktop-overlay/ui/"*.enc; do
    [ -e "$f" ] || continue
    cp -f "$f" "$PUB/overlay/"; N=$((N+1))
  done
  find "$PUB/overlay" -maxdepth 1 -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' \) ! -name '*.enc' -delete 2>/dev/null
  [ "$N" = "0" ] && echo "[assistant] 警告：overlay/ 里没有任何 .enc（面板会打不开）"
  for p in overlay-readme-zh.md:README_zh.md overlay-readme-en.md:README_en.md; do
    SRC_MD="$ROOT/tools/${p%%:*}"; DST_MD="$PUB/${p##*:}"
    [ -f "$SRC_MD" ] && cp -f "$SRC_MD" "$DST_MD"
  done
  echo "[assistant] ✓ exe+overlay 已发布到 Meter GomokuAssistant（引擎/视觉/模型由 build-assistant-release.js 补齐）"
fi
echo "[overlay] done"
