#!/usr/bin/env node
/**
 * 构建 ASan（AddressSanitizer）诊断版 GomokuVision.exe → desktop-vision/build/asan/
 *
 * 用途：定位识别引擎的内存越界 / 堆破坏（正常 release 构建表现为随机崩溃）。
 * 关键点：/fsanitize=address 会给 STL 容器加注解元数据，与**非 ASan 构建的
 * OpenCV 静态库**链接时 LNK2038（annotate_string/vector/optional 不匹配）——
 * 必须 /D_DISABLE_STL_ANNOTATION 让我方对象也输出 0 才能链接。
 *
 * 运行：desktop-vision/build/asan/ 下需要 clang_rt.asan_dynamic-x86_64.dll
 * （从 MSVC bin/Hostx64/x64/ 拷一份）；崩溃时 stderr 直接给出
 * 带源码行号的报告（需 vision.pdb 在同目录）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRCDIR = path.join(ROOT, 'desktop-vision', 'src');
const OCV = path.join(ROOT, 'tools', 'opencv-build', 'build', 'install');
const OUTDIR = path.join(ROOT, 'desktop-vision', 'build', 'asan');

function firstDir(p) {
  try {
    const a = fs.readdirSync(p).filter((n) => /^\d/.test(n)).sort();
    return a.length ? path.join(p, a[a.length - 1]) : null;
  } catch (e) { return null; }
}
const msvc = firstDir('C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC');
if (!msvc) { console.error('找不到 MSVC'); process.exit(1); }
const bin = path.join(msvc, 'bin', 'Hostx64', 'x64');
const sdk = fs.readdirSync('C:/Program Files (x86)/Windows Kits/10/Include')
  .filter((n) => /^10\./.test(n)).sort().pop();
const incRoot = 'C:/Program Files (x86)/Windows Kits/10/Include';
const libRoot = 'C:/Program Files (x86)/Windows Kits/10/Lib';
let staticlib = null;
for (const v of ['vc16', 'vc17', 'vc18']) {
  const p = path.join(OCV, 'x64', v, 'staticlib');
  if (fs.existsSync(path.join(p, 'opencv_core500.lib'))) { staticlib = p; break; }
}
if (!staticlib) { console.error('找不到 OpenCV 静态库'); process.exit(1); }

const INCLUDE = [
  path.join(msvc, 'include'),
  path.join(incRoot, sdk, 'ucrt'), path.join(incRoot, sdk, 'um'),
  path.join(incRoot, sdk, 'shared'), path.join(incRoot, sdk, 'winrt'),
  path.join(incRoot, sdk, 'cppwinrt'), path.join(OCV, 'include'),
];
const LIB = [
  path.join(msvc, 'lib', 'x64'),
  path.join(libRoot, sdk, 'ucrt', 'x64'), path.join(libRoot, sdk, 'um', 'x64'),
  staticlib,
];
const srcs = fs.readdirSync(SRCDIR).filter((f) => f.endsWith('.cpp')).sort()
  .map((f) => path.join(SRCDIR, f));
const env = {
  ...process.env,
  PATH: bin + ';' + process.env.PATH,
  INCLUDE: INCLUDE.join(';'),
  LIB: LIB.join(';'),
};
fs.mkdirSync(OUTDIR, { recursive: true });

const CV = [
  'opencv_imgcodecs500.lib', 'opencv_imgproc500.lib', 'opencv_geometry500.lib',
  'opencv_flann500.lib', 'opencv_core500.lib',
  'libjpeg-turbo.lib', 'libpng.lib', 'libjasper.lib', 'libclapack.lib',
  'zlib.lib', 'ittnotify.lib',
];
const SYS = [
  'ws2_32.lib', 'gdi32.lib', 'user32.lib', 'ole32.lib', 'oleaut32.lib',
  'advapi32.lib', 'shell32.lib', 'shlwapi.lib',
];

const objs = srcs.map((f) => path.join(OUTDIR, path.basename(f, '.cpp') + '.obj'));
for (let i = 0; i < srcs.length; ++i) {
  console.log('[asan] 编译 ' + path.basename(srcs[i]) + ' …');
  const r = spawnSync(path.join(bin, 'cl.exe'), [
    '/nologo', '/c', '/O1', '/MT', '/Zi', '/EHsc', '/std:c++17', '/utf-8',
    '/fsanitize=address',
    // ★ 关键：与非 ASan 的 OpenCV 静态库共存（避免 LNK2038 annotate 不匹配）
    '/D_DISABLE_STL_ANNOTATION',
    '/DUNICODE', '/D_UNICODE', '/DNDEBUG', '/wd4244', '/wd4267', '/wd4996',
    ...INCLUDE.map((p) => '/I' + p),
    '/Fo:' + objs[i],
    srcs[i],
  ], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    console.log((r.stdout || '') + (r.stderr || ''));
    process.exit(1);
  }
}

console.log('[asan] 链接 …');
const r = spawnSync(path.join(bin, 'link.exe'), [
  '/nologo',
  '/OUT:' + path.join(OUTDIR, 'GomokuVision.exe'),
  '/SUBSYSTEM:CONSOLE', '/MACHINE:X64',
  '/DEBUG', '/PDB:' + path.join(OUTDIR, 'vision.pdb'),
  '/INFERASANLIBS',
  ...objs, ...CV, ...SYS,
], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
console.log(((r.stdout || '') + (r.stderr || '')).trim());
if (r.status !== 0) process.exit(1);

// ASan 动态运行时 DLL 拷到 exe 旁边，免 PATH
const dll = path.join(bin, 'clang_rt.asan_dynamic-x86_64.dll');
const dst = path.join(OUTDIR, 'clang_rt.asan_dynamic-x86_64.dll');
if (fs.existsSync(dll)) fs.copyFileSync(dll, dst);
console.log('[asan] 完成：' + path.join(OUTDIR, 'GomokuVision.exe'));
