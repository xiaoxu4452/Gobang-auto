#!/usr/bin/env bash
# 连线版（Meter Gomoku 专用）构建脚本 —— 与 build-calculator-msvc.sh 同源，
# 源码用 desktop-connect/（fork），产物直接发布到特殊文件夹 Meter Gomoku/，
# **不碰** Meter GomokuTrainer / Desktop version / Meter engine-server 三个常规目录。
set -u

export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

ROOT="C:/Users/harve/Desktop/Gobang auto"
NODE="C:/Users/harve/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
MSVC="C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231"
SDKI="C:/Program Files (x86)/Windows Kits/10/Include/10.0.26100.0"
SDKL="C:/Program Files (x86)/Windows Kits/10/Lib/10.0.26100.0"
SDKB="C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64"
W2="$ROOT/tools/webview2-sdk"

SRC="$ROOT/desktop-connect/src/host.cpp"
OUTDIR="$ROOT/desktop-connect/build"
OBJDIR="$OUTDIR/obj"
REL="$ROOT/Meter Gomoku"
EXE="$REL/Desktop GomokuTrainer.exe"

CL="$MSVC/bin/Hostx64/x64/cl.exe"
LK="$MSVC/bin/Hostx64/x64/link.exe"

LKBASE=(/nologo /SUBSYSTEM:WINDOWS /LTCG /OPT:REF /OPT:ICF /MACHINE:X64
        "$W2/lib/x64/WebView2LoaderStatic.lib")

export INCLUDE="$MSVC/include;$SDKI/ucrt;$SDKI/um;$SDKI/shared;$SDKI/winrt;$SDKI/cppwinrt"
export LIB="$MSVC/lib/x64;$SDKL/ucrt/x64;$SDKL/um/x64"

mkdir -p "$OBJDIR" "$OUTDIR"

CLBASE=(/nologo /c /O2 /Os /GL /MT /EHsc /std:c++17 /utf-8
        /DUNICODE /D_UNICODE /DNDEBUG /DGB_SUITE_ENGINE "/I$W2/include")
# ★ 2026-10-06（用户报「AI 执黑/执白不工作」根因）：缺 /DGB_SUITE_ENGINE → host.cpp 里
#   EnsureEngine（拉起 :8964 引擎后端 + 看门狗）整段没编译 → 页面永远「引擎未连接 ·
#   正在重试…」→ 开关亮但 AI 永不动。三件套版（build-calculator-msvc.sh 54 行）有这个宏。
LIBS=(user32.lib gdi32.lib ole32.lib oleaut32.lib uuid.lib shell32.lib shlwapi.lib
      ws2_32.lib advapi32.lib comctl32.lib comdlg32.lib gdiplus.lib
      winmm.lib)
# ★ 2026-10-09（用户：「移动速度还要再提一提，提到之前的 3 倍左右」）：加 winmm.lib ——
#   真实点击的平滑滑行要在滑行期间用 timeBeginPeriod(1) 把 Sleep 粒度从 15.6ms 提到 ~1ms
#   （实测 Sleep(4) 默认要睡 15.63ms；提到 1ms 精度后是 4.6ms ⇒ 同样的步数快 3.4×）。

# ---- 版本资源（fork 源码树独立生成，不碰共享树）----
# ★ 2026-10-09：**去掉写死的版本覆盖实参** —— 版本号只认 `desktop-connect/ui/calc.js` 的
#   `APP_VERSION`（与共享树的 build-calculator-msvc.sh 同口径）。写死一份就是第二个真相源：
#   上次改版只改了 calc.js，exe 资源却还是旧号，两处漂移没人发现。现在命令只指 --calc，
#   gen-appver-rc.js 自己从 calc.js 读版本。
ICON=()
"$NODE" "$ROOT/tools/gen-appver-rc.js" \
  --calc "$ROOT/desktop-connect/ui/calc.js" --out-dir "$ROOT/desktop-connect/src" \
  || { echo "[connect] 版本资源生成失败"; exit 1; }
if [ -f "$ROOT/desktop-connect/src/Calculator.ico" ] && [ -f "$ROOT/desktop-connect/src/icon.rc" ]; then
  if "$SDKB/rc.exe" /nologo "/fo$OBJDIR/icon.res" "$ROOT/desktop-connect/src/icon.rc" >/dev/null 2>&1; then
    ICON=("$OBJDIR/icon.res")
    echo "[connect] 图标资源已编入"
  fi
fi

echo "[connect] 编译 host.cpp ..."
# ★ 2026-10-11：构建期注入 UI 解密密钥（构建后还原）—— 10-10 的整理把 ui_crypto.h 里的
#   GB_CALC_UI_KEY 抹成了空占位（「key supplied at build time」），但没有任何脚本实现注入，
#   直接编译出的 exe 拿空键解密 ⇒ 发布包白屏。密钥的单一事实源 = encrypt-calc-ui.js 的
#   CALC_UI_KEY（32 字符），这里读出来临时写进头文件，编译链接完立刻还原，仓库保持无密钥。
CRYPTO_H="$ROOT/desktop-connect/src/ui_crypto.h"
UIKEY=$( "$NODE" -e "const s=require('fs').readFileSync('$ROOT/tools/encrypt-calc-ui.js','utf8');const m=/CALC_UI_KEY = '([^']{32})'/.exec(s);if(!m){console.error('no key');process.exit(1)}console.log(m[1])" ) \
  || { echo "[connect] 读不到 UI 密钥（encrypt-calc-ui.js）"; exit 1; }
cp -f "$CRYPTO_H" "$CRYPTO_H.bak"
trap 'mv -f "$CRYPTO_H.bak" "$CRYPTO_H" 2>/dev/null' EXIT
"$NODE" -e "
const fs=require('fs');const p='$CRYPTO_H';
let s=fs.readFileSync(p,'utf8');
if(!/GB_CALC_UI_KEY\\s*=\\s*\"\"/.test(s)){ console.error('[connect] ui_crypto.h 不是空占位，拒绝盲目注入'); process.exit(1); }
s=s.replace(/GB_CALC_UI_KEY\\s*=\\s*\"\"/, 'GB_CALC_UI_KEY = \"$UIKEY\"');
fs.writeFileSync(p,s);
" || { echo "[connect] 密钥注入失败"; exit 1; }
"$CL" "${CLBASE[@]}" "/Fo$OBJDIR/connect.obj" "$SRC" || { echo "[connect] 编译失败"; exit 1; }
echo "[connect] 链接 ..."
# ★ 2026-10-08（用户：「纯 c++ 硬链接，不需要 http」）：不再链 winhttp.lib ——
#   host.cpp 已无任何 HTTP 客户端（识别 = 命名管道 + 共享内存；引擎 = 进程内 /engine/* 桥）。
"$LK" "${LKBASE[@]}" "/OUT:$EXE" "$OBJDIR/connect.obj" "${ICON[@]}" "${LIBS[@]}" \
  || { echo "[connect] 链接失败"; exit 1; }
ls -l "$EXE"

# ---- UI 密文 → Meter Gomoku/calc/（.enc；发布目录磁盘无明文）----
echo "[connect] 加密 UI → Meter Gomoku/calc/"
"$NODE" "$ROOT/tools/encrypt-calc-ui.js" \
  --src "$ROOT/desktop-connect/ui" --out "$REL/calc" \
  || { echo "[connect] UI 加密失败"; exit 1; }

echo "[connect] done → $REL"
