#!/usr/bin/env node
/**
 * pack-rapfi-native.js —— 把「原生 Rapfi 引擎 + 官方权重 + 配置」装成发布目录里的 rapfi-native/。
 *
 * 为什么单独一个包目录（而不是散在发布根目录）：
 *   ① 权重的相对路径由 config.toml 决定（model210901.bin / mix9svq*.bin.lz4 都是**相对 cwd**），
 *      宿主起引擎时把 cwd 设成这个目录，路径就永远自洽，不受发布目录里其它文件影响；
 *   ② 让「这个包到底带不带原生引擎」变成**一个目录是否存在**这么简单的事实 ——
 *      三合一版不部署 rapfi-native/，页面就自动回落 WASM（用户要求：仅仅替换纯训练器版本）。
 *
 * ★ 权重来源与「同源」保证：NNUE 权重直接取自 engine-server/resources/rapfi-multi.data
 *   （见 tools/extract-rapfi-networks.js），与网页/桌面版 WASM 用的**逐字节相同**。
 *
 * ★ 2026-09-29 起发的是**官方预编译二进制**（tools/rapfi-official/，Rapfi 0.43.01 / 250615），
 *   于是 classic model 必须用配套的**旧格式** model210901.bin（23 204 B）—— Networks/ 里那份
 *   （30 109 B，master/current 格式）官方二进制会直接拒绝加载（ERROR → exit 1）。
 *   一句话：**二进制与 classic model 必须同代**，换一边就得换另一边。
 *
 * ★ config.toml 用**原样那一份**，不要换成官方 config-example：
 *   官方样例 `coord_conversion_mode = "none"`，而这份包/页面的协议（toEngineMoveList /
 *   parseForbidLine 的 SIZE-1-y）是按 `X_flipY` 写的 —— 换掉会**整盘镜像**，是最贵的一类错。
 *
 * 用法：node tools/pack-rapfi-native.js [--out <目录>]
 *   默认 --out "Meter GomokuTrainer/rapfi-native"
 * 也可被 build-calculator.js require 后调用 packRapfiNative(dstDir)。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'tools', 'rapfi-build');
const OFFICIAL = path.join(ROOT, 'tools', 'rapfi-official');   // ★ 官方 250615 预编译变体（首选来源）
const NET = path.join(ROOT, 'tools', 'rapfi-src', 'Networks');

// 权重与配置（显式清单：别用通配，避免把 official-config-example 之类的参考件混进发布包）
const WEIGHT_FILES = [
  'config.toml',
  'classical210901.toml',
  'classical220723.toml',
  'mix9svqfreestyle_bsmix.bin.lz4',
  'mix9svqstandard_bs15.bin.lz4',
  'mix9svqrenju_bs15_black.bin.lz4',
  'mix9svqrenju_bs15_white.bin.lz4',
  'model210901.bin',
  'model220723.bin',
];
// ★ 2026-09-29（用户定）：改发**官方 250615 的 5 个预编译 CPU 变体**（avx512vnni > avxvnni >
//   avx512 > avx2 > sse），宿主按 CPUID + 冒烟挑一个。理由：① 官方变体与官方 model210901.bin
//   同格式；② 8 秒对拍下官方 0.43.01 节点数 1727K > 我们自编译 master 的 1442K（nps 353K vs
//   303K），并不比自编译慢。⚠️ 官方这套只认**旧格式** model210901.bin（23 204 B），
//   而 tools/rapfi-src/Networks/ 里那份是 master 需要的**新格式**（30 109 B）——二者不通用，
//   所以下面的 model210901.bin 一律从 tools/rapfi-official/ 取，别改成 NET 里的那份。
//   自编译产物（tools/rapfi-build/）仍在 SRC 里保留，缺官方包时作为兜底。
const EXE_FILES = [
  ['avx512vnni', 'RapfiEngine-avx512vnni.exe', 'pbrain-rapfi-windows-avx512vnni.exe'],
  ['avxvnni', 'RapfiEngine-avxvnni.exe', 'pbrain-rapfi-windows-avxvnni.exe'],
  ['avx512', 'RapfiEngine-avx512.exe', 'pbrain-rapfi-windows-avx512.exe'],
  ['avx2', 'RapfiEngine-avx2.exe', 'pbrain-rapfi-windows-avx2.exe'],
  ['sse', 'RapfiEngine-sse.exe', 'pbrain-rapfi-windows-sse.exe'],
];
const OFFICIAL_ONLY_FILES = ['model210901.bin'];   // 只从官方包取（格式必须匹配官方二进制）

function mb(n) { return (n / 1048576).toFixed(2) + ' MB'; }

/**
 * 把原生引擎 + 权重装进 outDir。
 * @param {string} outDir 目标目录（通常是 <发布目录>/rapfi-native）
 * @param {{quiet?: boolean, strict?: boolean}} [opt]
 *        quiet  = 少打日志（被主构建脚本调用时用）
 *        strict = 一个引擎 exe 都没有时抛错（独立运行时用；主构建调用时传 false，别因缺引擎阻断整包）
 * @returns {{ok: boolean, exes: number, files: number, bytes: number, out: string}}
 */
function packRapfiNative(outDir, opt) {
  opt = opt || {};
  const log = opt.quiet ? function () {} : function () { console.log.apply(console, arguments); };
  fs.mkdirSync(outDir, { recursive: true });

  // ★★ 2026-09-30（用户报「别的电脑上加载不了模型」的根因修复）：**打包前必须清掉本机残留**。
  //   rapfi-native/ 就在开发机上，于是这三类文件会被一起拷进发布包，而它们全是**本机专属**：
  //     · .variant-ok   —— 本机挑中的 ISA 变体（如 avx512vnni）。带出去 = 别的电脑**跳过探测
  //                        直接复用** → 撞上不支持的指令集 → 引擎 SIGILL 秒退（exit 0xC000001D）
  //                        → 表现正是「模型加载不了 / 引擎起不来」，而开发机永远复现不了。
  //                        （宿主侧也加了 CPU 指纹校验做双保险，但发布侧必须根本不产生它。）
  //     · rapfi.db / rapfi_bak*.db —— 本机的对局库与备份，属于用户数据，不该随包分发。
  //   清理只在这个**输出目录**里做，绝不碰 tools/rapfi-official 等源目录。
  const STALE = ['.variant-ok', 'rapfi.db', 'rapfi_bak1.db', 'rapfi_bak2.db', 'rapfi_bak3.db'];
  for (const f of STALE) {
    const fp = path.join(outDir, f);
    if (fs.existsSync(fp)) { fs.unlinkSync(fp); console.error('[pack-rapfi] - 清掉本机残留 ' + f); }
  }

  let total = 0, nExe = 0;
  for (const [variant, name, officialName] of EXE_FILES) {
    let s = path.join(OFFICIAL, officialName);                 // ① 官方预编译
    if (!fs.existsSync(s)) s = path.join(SRC, variant, name);  // ② 兜底：自编译产物
    if (!fs.existsSync(s)) {
      console.error('[pack-rafi] ! 缺 ' + path.relative(ROOT, s) +
        '（官方包在 tools/rapfi-official/；自编译先跑 bash tools/build-rapfi-native.sh ' + variant + '）');
      continue;
    }
    fs.copyFileSync(s, path.join(outDir, name));
    const sz = fs.statSync(s).size;
    total += sz; nExe++;
    log('  ' + name.padEnd(26) + ' ' + mb(sz));
  }
  if (nExe === 0) {
    if (opt.strict) throw new Error('一个引擎 exe 都没有，拒绝生成 rapfi-native/');
    return { ok: false, exes: 0, files: 0, bytes: 0, out: outDir };
  }

  let nFile = 0;
  for (const f of WEIGHT_FILES) {
    // model210901.bin 必须与引擎二进制**同代**（官方二进制要旧格式、自编译 master 要新格式），
    // 所以它只从官方包取，绝不从 Networks/ 取——取错就是「引擎起来就 ERROR 退出」。
    const s = OFFICIAL_ONLY_FILES.indexOf(f) >= 0 && fs.existsSync(path.join(OFFICIAL, f))
      ? path.join(OFFICIAL, f)
      : path.join(NET, f);
    if (!fs.existsSync(s)) {
      if (opt.strict) throw new Error('缺权重文件 ' + path.relative(ROOT, s));
      console.error('[pack-rafi] ! 缺权重 ' + f + '，跳过（原生引擎可能起不来）');
      continue;
    }
    fs.copyFileSync(s, path.join(outDir, f));
    const sz = fs.statSync(s).size;
    total += sz; nFile++;
    log('  ' + f.padEnd(32) + ' ' + mb(sz));
  }

  // ---- 许可与出处（Rapfi 是 GPLv3，随包必须带上许可与源码出处）----
  const lic = path.join(ROOT, 'tools', 'rapfi-src', 'Copying.txt');
  if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(outDir, 'COPYING-GPLv3.txt'));
  fs.writeFileSync(path.join(outDir, 'NOTICE.txt'),
    'Rapfi —— Gomoku/Renju playing engine\r\n' +
    'Copyright (C) 2022 Rapfi developers\r\n' +
    'License: GNU General Public License v3.0 (see COPYING-GPLv3.txt)\r\n' +
    'Source:  https://github.com/dhbloo/rapfi  (branch master)\r\n' +
    'Weights: https://github.com/dhbloo/rapfi-networks  (mix9svq + classical)\r\n' +
    '\r\n' +
    'This directory contains the OFFICIAL prebuilt Windows binaries of Rapfi 0.43.01\r\n' +
    '(release 250615, upstream: https://github.com/dhbloo/rapfi/releases).\r\n' +
    'Five CPU variants are shipped; the host picks one at startup by CPUID and then\r\n' +
    'runs a real 300ms search as a smoke test (a wrong pick would SIGILL at once):\r\n' +
    '  RapfiEngine-avx512vnni.exe  AVX512F/DQ/BW/VL + AVX512_VNNI\r\n' +
    '  RapfiEngine-avxvnni.exe     AVX2 + AVX-VNNI (VEX; Intel Alder Lake+ / AMD Zen5+)\r\n' +
    '  RapfiEngine-avx512.exe      AVX512F/DQ/BW/VL\r\n' +
    '  RapfiEngine-avx2.exe        AVX2 + FMA + BMI2\r\n' +
    '  RapfiEngine-sse.exe         baseline (any x64)\r\n' +
    'NOTE: these binaries require the OLD-FORMAT classical model (model210901.bin,\r\n' +
    '23 204 bytes, shipped in this directory). The newer master-format file (30 109\r\n' +
    'bytes) is rejected by them - do not swap it in.\r\n' +
    'Pack script: tools/pack-rapfi-native.js  (staging: tools/rapfi-official/)\r\n' +
    'Weights extraction: tools/extract-rapfi-networks.js\r\n', 'utf8');

  log('[pack-rafi] ✓ ' + path.relative(ROOT, outDir) + '  ' + nExe + ' exe + ' +
    nFile + ' 数据文件，合计 ' + mb(total));
  return { ok: true, exes: nExe, files: nFile, bytes: total, out: outDir };
}

module.exports = { packRapfiNative: packRapfiNative };

// ---- 命令行入口 ----
if (require.main === module) {
  const outArg = process.argv.indexOf('--out');
  const out = outArg >= 0 && process.argv[outArg + 1]
    ? path.resolve(ROOT, process.argv[outArg + 1])
    : path.join(ROOT, 'Meter GomokuTrainer', 'rapfi-native');
  try {
    const r = packRapfiNative(out, { strict: true });
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error('[pack-rafi] ✗ ' + e.message);
    process.exit(1);
  }
}
