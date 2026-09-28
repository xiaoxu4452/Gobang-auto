#!/usr/bin/env bash
# 只重发 UI（enc），不重编译 exe —— 改 calc.html/js/css 后最省时的发布路径。
# 等价 release-calculator.sh 的 2/4 · 3/4 · 4/4 三步，跳过 1/4 的 MSVC 编译。
# 用法：bash tools/republish-calc-ui.sh
set -e
export MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1
# ⚠ 必须用 `pwd -W`（Windows 风格 C:/...）—— node.exe 是原生 Windows 程序，喂它 /c/...
#   这种 MSYS 路径会被当成「当前盘符下的相对路径」，变成 C:\c\Users\... → MODULE_NOT_FOUND。
ROOT="$(cd "$(dirname "$0")/.." && pwd -W)"
NODE="${GB_NODE:-/c/Users/harve/.workbuddy/binaries/node/versions/22.22.2-3/node.exe}"
OUTDIR="$ROOT/desktop-calculator/build"
UI="$ROOT/desktop-calculator/ui"

stage() {   # $1 = 目标目录, $2 = 注入文件, $3 = 注入行
  rm -rf "$1"; mkdir -p "$1"
  for f in "$UI"/*.html "$UI"/*.js "$UI"/*.css; do
    [ -e "$f" ] || continue
    b="$(basename "$f")"
    case "$b" in _*) continue ;; esac
    cp -f "$f" "$1/$b"
  done
  { printf '%s\n' "$3"; cat "$UI/$2"; } > "$1/$2"
}

echo "======== 2/4 独立版 UI 加密（GB_NO_WASM）========"
stage "$OUTDIR/std-ui" engine-ai.js 'var GB_NO_WASM = true;'
"$NODE" "$ROOT/tools/encrypt-calc-ui.js" --src "$OUTDIR/std-ui" --out "$OUTDIR/ui-enc" >/dev/null

echo "======== 3/4 三件套版 UI 加密（GB_AI_REMOTE）========"
stage "$OUTDIR/suite-ui" calc.js 'var GB_AI_REMOTE = true;'
"$NODE" "$ROOT/tools/encrypt-calc-ui.js" --src "$OUTDIR/suite-ui" --out "$OUTDIR/suite-ui-enc" >/dev/null

echo "======== 4/4 发布 ========"
copy_enc() {
  local dst="$1/calc" stage="$2"
  mkdir -p "$dst"
  rm -f "$dst"/*.html "$dst"/*.js "$dst"/*.css "$dst"/*.enc
  cp -f "$stage"/*.enc "$dst"/
  echo "  ✓ $1/calc ← $(ls "$stage"/*.enc | wc -l) 个 .enc"
}
copy_enc "$ROOT/Meter GomokuTrainer" "$OUTDIR/ui-enc"
copy_enc "$ROOT/Desktop version" "$OUTDIR/suite-ui-enc"
copy_enc "$ROOT/Meter engine-server" "$OUTDIR/suite-ui-enc"
# 开发态副本（host 拦截器无 .enc 时回落明文）
mkdir -p "$OUTDIR/calc"
cp -f "$UI/calc.html" "$UI/calc.js" "$UI/calc.css" "$OUTDIR/calc/" 2>/dev/null || true
[ -f "$UI/engine-ai.js" ] && cp -f "$UI/engine-ai.js" "$OUTDIR/calc/" 2>/dev/null || true
echo "[republish-ui] done"
