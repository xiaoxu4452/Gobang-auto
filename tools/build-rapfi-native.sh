#!/usr/bin/env bash
# build-rapfi-native.sh —— 原生编译 Rapfi 引擎（纯 C++，替代 WASM 版）。
#
# 为什么绕过 CMake：本机没有独立 cmake/ninja/clang（只有 VS 自带的 cmake.exe），而
# 沙箱禁止 node 派发子进程（spawnSync EBUSY），只能从 bash 直接驱动 cl/link。
# 参数完全按 Rapfi/Rapfi/CMakeLists.txt 的口径搬过来，逐条对齐：
#   · NO_COMMAND_MODULES  → 不定义 COMMAND_MODULES（与 wasm 版同口径，main() 直接进 gomocupLoop）
#   · MULTI_THREADING     → 定义 MULTI_THREADING（原生 std::thread，真正的 OS 线程）
#   · USE_AVX2/512+BMI2+VNNI → 定义对应宏 + /arch: + /D__AVX2__ 系列（CMakeLists 里 MSVC 分支原样）
#   · MSVC Release        → /O2（CMake 在 MSVC 下把 /O2 换成 /Ox）+ /MT 静态运行库
#
# 用法：bash tools/build-rapfi-native.sh avx512|avx2 [--skip-link]
set -u

export MSYS2_ARG_CONV_EXCL='*'    # 关掉 Git Bash 的 /xxx → 路径 转换（否则 /utf-8、/arch: 全废）
export MSYS_NO_PATHCONV=1

VARIANT="${1:-avx512}"

ROOT="C:/Users/harve/Desktop/Gobang auto"
RSRC="$ROOT/tools/rapfi-src/Rapfi"
EXT="$RSRC/external"
MSVC="C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231"
SDKI="C:/Program Files (x86)/Windows Kits/10/Include/10.0.26100.0"
SDKL="C:/Program Files (x86)/Windows Kits/10/Lib/10.0.26100.0"

OUTDIR="$ROOT/tools/rapfi-build/$VARIANT"
OBJDIR="$OUTDIR/obj"

CL="$MSVC/bin/Hostx64/x64/cl.exe"
LK="$MSVC/bin/Hostx64/x64/link.exe"

export INCLUDE="$MSVC/include;$SDKI/ucrt;$SDKI/um;$SDKI/shared;$SDKI/winrt;$SDKI/cppwinrt"
export LIB="$MSVC/lib/x64;$SDKL/ucrt/x64;$SDKL/um/x64"

# ---- 源码清单（抄自 CMakeLists.txt 的 CORE_SOURCES）----
SOURCES=(
  command/argutils.cpp command/benchmark.cpp command/command.cpp command/dbcommand.cpp
  command/gomocup.cpp
  core/compressor.cpp core/hash.cpp core/iohelper.cpp core/utils.cpp core/platform.cpp
  core/version.cpp
  database/dbclient.cpp database/dbconfig.cpp database/dbutils.cpp database/dbtypes.cpp
  database/renlib.cpp database/yxdbstorage.cpp
  eval/eval.cpp eval/evalconfig.cpp eval/evaluator.cpp eval/mix9svqnnue.cpp eval/mix10nnue.cpp
  game/board.cpp game/movegen.cpp game/pattern.cpp
  search/hashtable.cpp search/movepick.cpp search/opening.cpp search/searchcommon.cpp
  search/searchconfig.cpp search/searchengine.cpp search/searchoutput.cpp search/searchthread.cpp
  search/timecontrol.cpp
  search/ab/history.cpp search/ab/search.cpp
  search/mcts/node.cpp search/mcts/search.cpp
  config.cpp internalConfig.cpp main.cpp
)

# ---- ISA 开关 ----
DEFS=(/DMULTI_THREADING)
ARCH=()
case "$VARIANT" in
  avx512)
    DEFS+=(/DUSE_AVX512 /DUSE_BMI2 /DUSE_VNNI
           /D__SSE3__ /D__SSSE3__ /D__SSE4_1__ /D__AVX__ /D__AVX2__ /D__FMA__
           /D__AVX512F__ /D__AVX512DQ__ /D__AVX512BW__)
    ARCH=(/arch:AVX512)
    ;;
  avx2)
    DEFS+=(/DUSE_AVX2 /DUSE_BMI2 /D__SSE3__ /D__SSSE3__ /D__SSE4_1__ /D__AVX__ /D__AVX2__ /D__FMA__)
    ARCH=(/arch:AVX2)
    ;;
  *) echo "未知变体：$VARIANT（应为 avx512 | avx2）"; exit 1 ;;
esac

INCS=(
  "/I$RSRC"                       # 引擎内部用 "game/board.h" 这种相对 Rapfi/ 的路径
  "/I$EXT/cpptoml/include"
  "/I$EXT/cxxopts/include"
  "/I$EXT/lz4/include"
  "/I$EXT/simde/include"
)

CFLAGS=(/nologo /c /O2 /Oy- /GL /MT /EHsc /std:c++17 /utf-8 /bigobj
        /DNDEBUG /D_CRT_SECURE_NO_WARNINGS /DNOMINMAX
        /wd4244 /wd4267 /wd4996 /wd4100 /wd4456 /wd4457 /wd4458 /wd4459
        "${DEFS[@]}" "${ARCH[@]}" "${INCS[@]}")

mkdir -p "$OBJDIR"

echo "[rapfi:$VARIANT] 编译 ${#SOURCES[@]} 个 TU ..."
OBJS=()
i=0
for s in "${SOURCES[@]}"; do
  i=$((i+1))
  obj="$OBJDIR/$(echo "$s" | tr '/' '_' | sed 's/\.cpp$/.obj/')"
  printf '\r[rapfi:%s] [%2d/%2d] %-34s' "$VARIANT" "$i" "${#SOURCES[@]}" "$s"
  if ! "$CL" "${CFLAGS[@]}" "/Fo$obj" "$RSRC/$s" > "$OUTDIR/log_$(basename "$obj").txt" 2>&1; then
    echo; echo "[rapfi:$VARIANT] ✗ 编译失败：$s"; tail -25 "$OUTDIR/log_$(basename "$obj").txt"; exit 1
  fi
  OBJS+=("$obj")
done
echo

# ---- lz4（C 源，CMake 里是独立静态库；直接编进来）----
echo "[rapfi:$VARIANT] 编译 lz4 ..."
for c in lz4_all xxhash; do
  obj="$OBJDIR/lz4_$c.obj"
  "$CL" /nologo /c /O2 /MT /DNDEBUG "/I$EXT/lz4/include" "/Fo$obj" "$EXT/lz4/src/$c.c" \
    > "$OUTDIR/log_lz4_$c.txt" 2>&1 || { echo "[rapfi:$VARIANT] ✗ lz4 编译失败：$c"; tail -20 "$OUTDIR/log_lz4_$c.txt"; exit 1; }
  OBJS+=("$obj")
done

EXE="$OUTDIR/RapfiEngine-$VARIANT.exe"
echo "[rapfi:$VARIANT] 链接 $EXE ..."
"$LK" /nologo "/OUT:$EXE" /SUBSYSTEM:CONSOLE /LTCG /OPT:REF /OPT:ICF /MACHINE:X64 \
  "${OBJS[@]}" \
  ws2_32.lib user32.lib advapi32.lib shell32.lib \
  || { echo "[rapfi:$VARIANT] ✗ 链接失败"; exit 1; }

ls -l "$EXE"
echo "[rapfi:$VARIANT] done"
