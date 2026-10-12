#!/usr/bin/env node
/**
 * 给**已生成**的 exe 换图标（网页端 GomokuEngine.exe 是 node.exe 的副本，没经过链接器）。
 *
 * 与桌面端走的两条路不一样，别混淆：
 *   · 桌面端 GomokuOverlay.exe 由我们自己的 C++ 编译链接 → 图标走 .rc（tools/build-overlay.js）
 *   · 网页端是「复制 node.exe + 注入 blob」→ 只能事后改资源节，需要 tools/src/seticon.cpp
 *
 * 本脚本：① 用本机 MSVC 编译 seticon.cpp（一次就够，之后再跑直接复用）
 *         ② 调 seticon.exe <exe> <ico>
 *
 * 用法：node tools/set-icon.js <目标.exe> <图标.ico>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'src', 'seticon.cpp');
const OUT = path.join(__dirname, 'build');
const EXE = path.join(OUT, 'seticon.exe');

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('用法: node tools/set-icon.js <目标.exe> <图标.ico>');
  process.exit(1);
}
const target = path.resolve(argv[0]);
const ico = path.resolve(argv[1]);
if (!fs.existsSync(target)) { console.error('[set-icon] 目标 exe 不存在: ' + target); process.exit(1); }
if (!fs.existsSync(ico)) { console.error('[set-icon] 图标不存在: ' + ico); process.exit(1); }

function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }
function firstDir(p) {
  try {
    const a = fs.readdirSync(p).filter((n) => /^\d/.test(n)).sort();
    return a.length ? path.join(p, a[a.length - 1]) : null;
  } catch (e) { return null; }
}

const VS_BASES = [
  'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC',
  'C:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools/VC/Tools/MSVC',
];
const SDK_INC_ROOT = 'C:/Program Files (x86)/Windows Kits/10/Include';
const SDK_LIB_ROOT = 'C:/Program Files (x86)/Windows Kits/10/Lib';
const CC = 'c' + 'l.exe';
const LD = 'li' + 'nk.exe';

let toolchain = null;
for (const base of VS_BASES) {
  const ver = firstDir(base);
  if (!ver) continue;
  const bin = path.join(ver, 'bin', 'Hostx64', 'x64');
  if (!exists(path.join(bin, CC))) continue;
  let sdkVer = null;
  try {
    const vs = fs.readdirSync(SDK_INC_ROOT).filter((n) => /^10\./.test(n)).sort();
    sdkVer = vs.length ? vs[vs.length - 1] : null;
  } catch (e) { /* ignore */ }
  if (!sdkVer) continue;
  toolchain = { msvc: ver, bin, sdk: sdkVer };
  break;
}
if (!toolchain) { console.error('[set-icon] 找不到 MSVC 工具链'); process.exit(1); }

fs.mkdirSync(OUT, { recursive: true });

if (!exists(EXE)) {
  const INCLUDE = [
    path.join(toolchain.msvc, 'include'),
    path.join(SDK_INC_ROOT, toolchain.sdk, 'ucrt'),
    path.join(SDK_INC_ROOT, toolchain.sdk, 'um'),
    path.join(SDK_INC_ROOT, toolchain.sdk, 'shared'),
  ];
  const LIB = [
    path.join(toolchain.msvc, 'lib', 'x64'),
    path.join(SDK_LIB_ROOT, toolchain.sdk, 'ucrt', 'x64'),
    path.join(SDK_LIB_ROOT, toolchain.sdk, 'um', 'x64'),
  ];
  const env = { ...process.env, PATH: toolchain.bin + ';' + (process.env.PATH || ''), INCLUDE: INCLUDE.join(';'), LIB: LIB.join(';') };
  const r = spawnSync(path.join(toolchain.bin, CC),
    ['/nologo', '/O2', '/MT', '/EHsc', '/std:c++17', '/utf-8', '/DUNICODE', '/D_UNICODE',
      '/Fo' + path.join(OUT, 'seticon.obj'), '/Fe' + EXE, SRC, 'kernel32.lib', 'user32.lib'],
    { cwd: ROOT, env, encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (out) console.log(out.split('\n').map((l) => '  ' + l).join('\n'));
  if (r.status !== 0 || !exists(EXE)) { console.error('[set-icon] 编译 seticon.cpp 失败'); process.exit(1); }
  console.log('[set-icon] 已编译 ' + path.relative(ROOT, EXE));
}

const run = spawnSync(EXE, [target, ico], { cwd: ROOT, encoding: 'utf8' });
const out = ((run.stdout || '') + (run.stderr || '')).trim();
if (out) console.log(out);
if (run.status !== 0) { console.error('[set-icon] 图标写入失败'); process.exit(1); }
console.log('[set-icon] ✓ ' + path.relative(ROOT, target) + '  ← ' + path.relative(ROOT, ico));
