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
  // dnn（2026-10-02 YOLO 双链路）：YOLOv8 ONNX 推理走 OpenCV DNN；
  // libprotobuf 是 dnn 的编译期依赖（opencv-onnx.pb.cc），必须一起链。
  'opencv_dnn500.lib', 'libprotobuf.lib',
  'libjpeg-turbo.lib', 'libpng.lib', 'libjasper.lib', 'libclapack.lib',
  'zlib.lib', 'ittnotify.lib',
];
const SYS_LIBS = [
  'ws2_32.lib', 'gdi32.lib', 'user32.lib', 'ole32.lib', 'oleaut32.lib',
  'advapi32.lib', 'shell32.lib', 'shlwapi.lib',
  // gbscreen（DXGI 桌面复制抓屏）依赖：d3d11/dxgi 均为系统库
  'd3d11.lib', 'dxgi.lib',
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
  return out;
}

const objs = [];
for (const src of SOURCES) {
  const obj = path.join(OBJDIR, src.replace(/\.cpp$/, '.obj'));
  console.log('[vision] 编译 ' + src + ' …');
  run(CC, clArgs(obj, path.join(SRCDIR, src)), '编译 ' + src);
  objs.push(obj);
}

// ---- 双目标（2026-10-02 任务 #93 视觉硬连接·定案架构：识图是 EXE（壳），模型是 DLL）----
// exe：识图服务壳（gb + gbhttp + main + gbloader）—— **不链任何 OpenCV**，
//      模型代码全仓库只有 DLL 这一份（不再 exe+dll 两份冗余）；
// dll：识别模型库（检测/读子/仲裁 + 抓屏核心 + gbscanapi + gbdll 导出层）——
//      OpenCV（含 dnn/protobuf，YOLO 双链路）全在这里；崩溃隔离边界 = 服务进程。
const baseName = (p) => path.basename(p);
const exeObjs = objs.filter((o) => {
  const n = baseName(o);
  // 壳 = JSON/工具 + HTTP + 管道(#108) + 入口 + 加载器；模型侧翻译单元一律不进壳
  return ['gb.obj', 'gbhttp.obj', 'gbpipe.obj', 'main.obj', 'gbloader.obj'].includes(n);
});
const dllObjs = objs.filter((o) => {
  const n = baseName(o);
  // 模型库不链 gbhttp/gbpipe/main/gbloader（无 winsock、无管道语义、无进程入口语义）
  return !['gbhttp.obj', 'gbpipe.obj', 'main.obj', 'gbloader.obj'].includes(n);
});
const dll = path.join(OUTDIR, 'GomokuVision.dll');

console.log('[vision] 链接 GomokuVision.exe（识图服务壳，无 OpenCV）…');
run(LD, [
  '/nologo',
  '/OUT:' + exe,
  '/SUBSYSTEM:CONSOLE',
  '/LTCG',
  '/OPT:REF', '/OPT:ICF',
  '/MACHINE:X64',
  ...exeObjs,
  'ws2_32.lib', 'user32.lib', 'gdi32.lib', 'advapi32.lib',
], '链接 exe');

console.log('[vision] 链接 GomokuVision.dll（识别模型库）…');
run(LD, [
  '/nologo',
  '/DLL',
  '/OUT:' + dll,
  '/LTCG',
  '/OPT:REF', '/OPT:ICF',
  '/MACHINE:X64',
  ...dllObjs,
  ...CV_LIBS,
  ...SYS_LIBS.filter((l) => l !== 'ws2_32.lib'),
], '链接 dll');

// 导出表守护：4 个导出缺一不可 —— 缺了壳的 /health 直接 503，宿主巡检立刻知道
const DB = 'du' + 'mpbin.exe';
const expLog = run(DB, ['/nologo', '/EXPORTS', dll], '导出表');
for (const fn of ['GbvScan', 'GbvScanImage', 'GbvRecognizeJson', 'GbvVersion']) {
  if (!new RegExp('\\b' + fn + '\\b').test(expLog)) {
    console.error('[vision] GomokuVision.dll 缺少导出 ' + fn);
    process.exit(1);
  }
}

const sz = fs.statSync(exe).size;
console.log('[vision] 产物：' + exe + '  (' + (sz / 1024 / 1024).toFixed(2) + ' MB)');
console.log('[vision] 产物：' + dll + '  (' + (fs.statSync(dll).size / 1024 / 1024).toFixed(2) + ' MB)');

// ---------------------------------------------------------------- 发布

if (PUBLISH) {
  // 发布目录（2026-09 起：服务目录 + 套件主目录；2026-10 补：Gomoku / GomokuAssistant 两个发布目录）。
  //   旧「Desktop version」已废弃。
  // ★ 任务 #108（2026-10-02）：视觉程序（exe+dll）独立放「与主 EXE 同级的 Vision\
  //   子文件夹」—— 两个宿主的 FindVisionExe / EnsureScanServer 都先认这个布局。
  const targets = [
    path.join(ROOT, 'Meter engine-server'),
    path.join(ROOT, 'Meter GomokuTrainer'),
    path.join(ROOT, 'Meter Gomoku'),
    path.join(ROOT, 'Meter GomokuAssistant'),
  ];
  for (const t of targets) {
    if (!exists(t)) { console.log('[vision] 跳过（目录不存在）：' + t); continue; }
    const vdir = path.join(t, 'Vision');
    fs.mkdirSync(vdir, { recursive: true });
    const dst = path.join(vdir, 'GomokuVision.exe');
    fs.copyFileSync(exe, dst);
    console.log('[vision] 已发布：' + dst);
    // ★ 任务 #93：DLL 与 exe 成对发布（缺了宿主自动回落 HTTP）
    const dstDll = path.join(vdir, 'GomokuVision.dll');
    fs.copyFileSync(dll, dstDll);
    console.log('[vision] 已发布：' + dstDll);
    // 旧布局（同级散放）清理：宿主已优先认 Vision\，散放残留在只会让人困惑
    for (const f of ['GomokuVision.exe', 'GomokuVision.dll']) {
      const old = path.join(t, f);
      if (fs.existsSync(old)) { fs.rmSync(old); console.log('[vision] 清理旧布局：' + old); }
    }
  }
}
