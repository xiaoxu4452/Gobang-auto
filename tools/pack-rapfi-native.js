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
 *   （见 tools/extract-rapfi-networks.js），与网页/桌面版 WASM 用的**逐字节相同**；
 *   两个 classic model（model210901/model220723）换成 **rapfi 官方 current 版**（30 109 / 77 518 B）——
 *   rapfi-multi.data 里那份是 2021/2022 年的旧格式（23 204 / 59 730 B），master 源码会拒绝加载
 *   （Config::loadModel 要求读完后正好 EOF，旧文件数组尺寸对不上）。其余一字未动。
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
const EXE_FILES = [
  ['avx512', 'RapfiEngine-avx512.exe'],
  ['avx2', 'RapfiEngine-avx2.exe'],
];

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

  let total = 0, nExe = 0;
  for (const [variant, name] of EXE_FILES) {
    const s = path.join(SRC, variant, name);
    if (!fs.existsSync(s)) {
      console.error('[pack-rafi] ! 缺 ' + path.relative(ROOT, s) +
        '（先跑 bash tools/build-rapfi-native.sh ' + variant + '）');
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
    const s = path.join(NET, f);
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
    'This directory contains a NATIVE (MSVC x64) build of Rapfi, compiled from the\r\n' +
    'official source with USE_AVX512/USE_AVX2 + USE_BMI2 + USE_VNNI and MULTI_THREADING.\r\n' +
    'Two binaries are shipped and the host picks one at startup by CPUID:\r\n' +
    '  RapfiEngine-avx512.exe  requires AVX512F/DQ/BW/VL + AVX512_VNNI\r\n' +
    '  RapfiEngine-avx2.exe    requires AVX2 + FMA + BMI2 (safe on any modern x64)\r\n' +
    'Build script: tools/build-rapfi-native.sh\r\n' +
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
