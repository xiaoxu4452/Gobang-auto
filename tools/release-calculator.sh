#!/usr/bin/env bash
# 临时：重建训练器 exe + 重加密 UI + 发布到三个目录（照抄 build-calculator.js 的落盘语义）。
# 为什么不用 node tools/build-calculator.js --publish：它内部用 spawnSync 调 cl/link/encrypt，
# 本沙箱下 spawnSync 全 EBUSY；改成 bash 直驱，参数逐条对齐。
set -u
export MSYS2_ARG_CONV_EXCL='*'; export MSYS_NO_PATHCONV=1

ROOT="C:/Users/harve/Desktop/Gobang auto"
NODE="C:/Users/harve/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
OUTDIR="$ROOT/desktop-calculator/build"
UI="$ROOT/desktop-calculator/ui"

echo "======== 1/4 编译两个 exe ========"
# ★ 2026-09-28：加了 `GB_SKIP_COMPILE=1` 开关 —— **只改 desktop-calculator/ui/**（html/css/js）时
#   不需要重编 exe（C++ 没动），跳过 MSVC 那几分钟，只做「重加密 + 重发布」。
#   护栏：两个 exe 必须已经存在，否则不许跳过（避免把不存在的 exe 当已发布）。
if [ "${GB_SKIP_COMPILE:-0}" = "1" ]; then
  if [ -f "$OUTDIR/Desktop GomokuTrainer.exe" ] && [ -f "$OUTDIR/suite/Desktop GomokuTrainer.exe" ]; then
    echo "  (GB_SKIP_COMPILE=1 → 跳过编译；只重加密 UI 并重发布)"
  else
    echo "GB_SKIP_COMPILE=1 但 build 目录里没有现成 exe，不能跳编译"; exit 1
  fi
else
  bash "$ROOT/tools/build-calculator-msvc.sh" || { echo "编译失败"; exit 1; }
fi

echo "======== 2/4 独立版 UI 加密（engine-ai.js 注入 GB_NO_WASM）========"
# ★ 2026-09-24（用户要求）：纯训练器版**不再带 WASM 引擎** —— 资源不发、页面也不回落。
#   注入 `var GB_NO_WASM = true;` 后，本机没有原生引擎时 Worker 会 bootfail 并给明确提示，
#   而不是 importScripts 一个 404 的 rapfi-multi.js 静默半死。三合一版不注入（回落路径保留）。
rm -rf "$OUTDIR/ui-enc" "$OUTDIR/std-ui"; mkdir -p "$OUTDIR/ui-enc" "$OUTDIR/std-ui"
for f in "$UI"/*.html "$UI"/*.js "$UI"/*.css; do
  [ -e "$f" ] || continue
  b="$(basename "$f")"
  case "$b" in _*) continue ;; esac
  cp -f "$f" "$OUTDIR/std-ui/$b"
done
{
  printf 'var GB_NO_WASM = true;\n'
  cat "$UI/engine-ai.js"
} > "$OUTDIR/std-ui/engine-ai.js"
"$NODE" "$ROOT/tools/encrypt-calc-ui.js" --src "$OUTDIR/std-ui" --out "$OUTDIR/ui-enc" || exit 1

echo "======== 3/4 三件套版 UI 加密（注入 GB_AI_REMOTE）======== "
rm -rf "$OUTDIR/suite-ui" "$OUTDIR/suite-ui-enc"
mkdir -p "$OUTDIR/suite-ui" "$OUTDIR/suite-ui-enc"
for f in "$UI"/*.html "$UI"/*.js "$UI"/*.css; do
  [ -e "$f" ] || continue
  b="$(basename "$f")"
  case "$b" in _*) continue ;; esac
  cp -f "$f" "$OUTDIR/suite-ui/$b"
done
{
  printf 'var GB_AI_REMOTE = true;\n'
  cat "$UI/calc.js"
} > "$OUTDIR/suite-ui/calc.js"
"$NODE" "$ROOT/tools/encrypt-calc-ui.js" --src "$OUTDIR/suite-ui" --out "$OUTDIR/suite-ui-enc" || exit 1

echo "======== 4/4 发布 ========"
# 清明文 + 清旧密文（等价 build-calculator.js 的 copyUIEnc）
copy_enc() {
  local dst="$1/calc" stage="$2"
  mkdir -p "$dst"
  rm -f "$dst"/*.html "$dst"/*.js "$dst"/*.css
  rm -f "$dst"/*.enc
  cp -f "$stage"/*.enc "$dst"/
  echo "  ✓ $1/calc ← $(ls "$stage"/*.enc | wc -l) 个 .enc"
}
if cp -f "$OUTDIR/Desktop GomokuTrainer.exe" "$ROOT/Meter GomokuTrainer/" 2>/dev/null; then
  echo "  ✓ Meter GomokuTrainer/Desktop GomokuTrainer.exe（独立版）"
else
  echo "  ! Meter GomokuTrainer 的 exe 被占用（训练器正在运行？）—— 请关掉后重发"
fi
copy_enc "$ROOT/Meter GomokuTrainer" "$OUTDIR/ui-enc"
# ★ 2026-09-24（用户要求）：纯训练器版**不再带 WASM 引擎**（幂等，每次发布都清一遍）——
#   引擎只有原生 rapfi-native/ 一条路；页面 GB_NO_WASM 保护 + audit 脚本双重守着「不能回来」。
rm -f "$ROOT/Meter GomokuTrainer/resources/rapfi-multi.js" \
      "$ROOT/Meter GomokuTrainer/resources/rapfi-multi.data" \
      "$ROOT/Meter GomokuTrainer/resources/rapfi-multi.wasm"
echo "  ✓ Meter GomokuTrainer/resources/ 无 WASM 引擎（只走原生）"
for d in "Desktop version" "Meter engine-server"; do
  if [ -d "$ROOT/$d" ]; then
    if cp -f "$OUTDIR/suite/Desktop GomokuTrainer.exe" "$ROOT/$d/" 2>/dev/null; then
      echo "  ✓ $d/Desktop GomokuTrainer.exe（三件套版）"
    else
      echo "  ! $d 的 exe 被占用 —— 请关掉后重发"
    fi
    copy_enc "$ROOT/$d" "$OUTDIR/suite-ui-enc"
  fi
done
echo "[release] done"
