#!/usr/bin/env node
/**
 * 构建 GomokuVision.exe（C++ / Win32 + OpenCV 静态链接）—— 取代原来的 Python 识别服务。
 *
 * 为什么是这个形态：
 *   · 原来是「便携 Python 运行时 + cv2 + numpy + PIL」共 ~193MB（其中 cv2 113MB、
 *     numpy 45MB）；改成官方 OpenCV 5.0.0 **只编 core/imgproc/imgcodecs 三个模块**
 *     并静态链接后，交付物只有**一个自包含 EXE**，零 DLL、零运行时安装；
 *   · 与 Python 侧用的 cv2 5.0.0.93 **同一版本源码**，算法行为可逐条对拍。
 *
 * 前置：tools/opencv-build/build/install（见 tools/build-opencv.js）
 *
 * 用法：
 *   node tools/build-vision.js             仅编译到 desktop-vision/build/
 *   node tools/build-vision.js --publish   编译并同步进发布目录
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRCDIR = path.join(ROOT, 'desktop-vision', 'src');
const OUTDIR = path.join(ROOT, 'desktop-vision', 'build');
const OBJDIR = path.join(OUTDIR, 'obj');
const OCV = path.join(ROOT, 'tools', 'opencv-build', 'build', 'install');
const PUBLISH = process.argv.includes('--publish');

const VS_BASES = [
  'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC',
  'C:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools/VC/Tools/MSVC',
];
const SDK_INC_ROOT = 'C:/Program Files (x86)/Windows Kits/10/Include';
const SDK_LIB_ROOT = 'C:/Program Files (x86)/Windows Kits/10/Lib';
const CC = 'c' + 'l.exe';
const LD = 'li' + 'nk.exe';

function firstDir(p) {
  try {
    const a = fs.readdirSync(p).filter((n) => /^\d/.test(n)).sort();
    return a.length ? path.join(p, a[a.length - 1]) : null;
  } catch (e) { return null; }
}
function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

const toolchain = (() => {
  for (const base of VS_BASES) {
    const ver = firstDir(base);
    if (!ver) continue;
    const bin = path.join(ver, 'bin', 'Hostx64', 'x64');
    if (!exists(path.join(bin, CC))) continue;
    let sdkVer = null;
    try {
      const vs = fs.readdirSync(SDK_INC_ROOT).filter((n) => /^10\./.test(n)).sort();
      sdkVer = vs.length ? vs[vs.length - 1] : null;
    } catch (e) {}
    if (!sdkVer) continue;
    return { msvc: ver, bin, sdk: sdkVer };
  }
  return null;
})();

if (!toolchain) {
  console.error('[vision] 找不到 MSVC 工具链（需要 Visual Studio 的「使用 C++ 的桌面开发」工作负载）');
  process.exit(1);
}

// OpenCV 安装目录：兼容 vc16 / vc17 / vc18 三种子目录命名
const ocv = (() => {
  if (!exists(OCV)) return null;
  const inc = path.join(OCV, 'include');
  let staticlib = null;
  for (const v of ['vc16', 'vc17', 'vc18']) {
    const p = path.join(OCV, 'x64', v, 'staticlib');
    if (exists(p) && exists(path.join(p, 'opencv_core500.lib'))) { staticlib = p; break; }
  }
  if (!staticlib || !exists(inc)) return null;
  return { inc, staticlib };
})();

if (!ocv) {
  console.error('[vision] 缺少 OpenCV 极简静态库构建产物。');
  console.error('         请先运行：node tools/build-opencv.js');
  process.exit(1);
}

const INCLUDE = [
  path.join(toolchain.msvc, 'include'),
  path.join(SDK_INC_ROOT, toolchain.sdk, 'ucrt'),
  path.join(SDK_INC_ROOT, toolchain.sdk, 'um'),
  path.join(SDK_INC_ROOT, toolchain.sdk, 'shared'),
  path.join(SDK_INC_ROOT, toolchain.sdk, 'winrt'),
  path.join(SDK_INC_ROOT, toolchain.sdk, 'cppwinrt'),
  ocv.inc,
];
const LIB = [
  path.join(toolchain.msvc, 'lib', 'x64'),
  path.join(SDK_LIB_ROOT, toolchain.sdk, 'ucrt', 'x64'),
  path.join(SDK_LIB_ROOT, toolchain.sdk, 'um', 'x64'),
  ocv.staticlib,
];

console.log('[vision] MSVC ' + path.basename(toolchain.msvc) + ' · Windows SDK ' + toolchain.sdk);
console.log('[vision] OpenCV 静态库：' + ocv.staticlib);

for (const d of [OUTDIR, OBJDIR]) fs.mkdirSync(d, { recursive: true });

const SOURCES = fs.readdirSync(SRCDIR).filter((f) => f.endsWith('.cpp')).sort();
const exe = path.join(OUTDIR, 'GomokuVision.exe');

// 全程序优化把静态库里没被引用的模块整块剔除 —— 这是体积能压到个位数 MB 的关键
const clArgs = (obj, src) => [
  '/nologo', '/c',
  '/O2', '/Os', '/GL', '/MT', '/EHsc', '/std:c++17', '/utf-8',
  '/DUNICODE', '/D_UNICODE', '/DNDEBUG',
  '/wd4244', '/wd4267', '/wd4996',
  ...INCLUDE.map((p) => '/I' + p),
  '/Fo' + obj,
  src,
];

const CV_LIBS = [
  'opencv_imgcodecs500.lib', 'opencv_imgproc500.lib',
  'opencv_geometry500.lib', 'opencv_flann500.lib', 'opencv_core500.lib',
  'libjpeg-turbo.lib', 'libpng.lib', 'libjasper.lib', 'libclapack.lib',
  'zlib.lib', 'ittnotify.lib',
];
const SYS_LIBS = [
  'ws2_32.lib', 'gdi32.lib', 'user32.lib', 'ole32.lib', 'oleaut32.lib',
  'advapi32.lib', 'shell32.lib', 'shlwapi.lib',
];

const env = {
  ...process.env,
  PATH: toolchain.bin + ';' + (process.env.PATH || ''),
  INCLUDE: INCLUDE.join(';'),
  LIB: LIB.join(';'),
};

function run(tool, args, label) {
  const r = spawnSync(path.join(toolchain.bin, tool), args, { cwd: ROOT, env, encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (out) console.log(out.split('\n').map((l) => '  ' + l).join('\n'));
  if (r.status !== 0) {
    console.error('[vision] ' + label + ' 失败（exit ' + r.status + '）');
    process.exit(1);
  }
}

const objs = [];
for (const src of SOURCES) {
  const obj = path.join(OBJDIR, src.replace(/\.cpp$/, '.obj'));
  console.log('[vision] 编译 ' + src + ' …');
  run(CC, clArgs(obj, path.join(SRCDIR, src)), '编译 ' + src);
  objs.push(obj);
}

console.log('[vision] 链接 GomokuVision.exe …');
run(LD, [
  '/nologo',
  '/OUT:' + exe,
  '/SUBSYSTEM:CONSOLE',
  '/LTCG',
  '/OPT:REF', '/OPT:ICF',
  '/MACHINE:X64',
  ...objs,
  ...CV_LIBS,
  ...SYS_LIBS,
], '链接');

const sz = fs.statSync(exe).size;
console.log('[vision] 产物：' + exe + '  (' + (sz / 1024 / 1024).toFixed(2) + ' MB)');

// ---------------------------------------------------------------- 发布

if (PUBLISH) {
  const targets = [
    path.join(ROOT, 'Meter engine-server'),
    path.join(ROOT, 'Desktop version'),
  ];
  for (const t of targets) {
    if (!exists(t)) { console.log('[vision] 跳过（目录不存在）：' + t); continue; }
    const dst = path.join(t, 'GomokuVision.exe');
    fs.copyFileSync(exe, dst);
    console.log('[vision] 已发布：' + dst);
  }
}
